require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const { version: APP_VERSION } = require('./package.json');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const JOB_DIR = path.join(DATA_DIR, 'jobs');
const TEMP_DIR = path.join(DATA_DIR, 'tmp');
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 2 * 1024 * 1024 * 1024);
const MAX_DURATION_SECONDS = Number(process.env.MAX_DURATION_SECONDS || 4 * 60 * 60);
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 10 * 60);
const CHUNK_OVERLAP_SECONDS = Number(process.env.CHUNK_OVERLAP_SECONDS || 2);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const STAGES = ['idle', 'video_selected', 'extracting', 'uploading', 'transcribing', 'completed', 'error', 'cancelled'];
const jobs = new Map();

function now() { return new Date().toISOString(); }
function uid() { return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`; }
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

async function ensureDirs() {
  await Promise.all([fsp.mkdir(JOB_DIR, { recursive: true }), fsp.mkdir(TEMP_DIR, { recursive: true })]);
}

async function writeJob(job) {
  job.updatedAt = now();
  jobs.set(job.id, job);
  const destination = path.join(JOB_DIR, `${job.id}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(job, null, 2), 'utf8');
  await fsp.rename(temporary, destination);
}

async function loadJobs() {
  await ensureDirs();
  const files = await fsp.readdir(JOB_DIR).catch(() => []);
  await Promise.all(files.filter((name) => name.endsWith('.json')).map(async (name) => {
    try {
      const job = JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), 'utf8'));
      if (job && job.id) jobs.set(job.id, job);
    } catch (_) { /* 损坏的历史任务不会阻止服务启动 */ }
  }));
}

function publicJob(job) {
  if (!job) return null;
  const { sourcePath, videoPath, audioPaths, rawProviderResponse, objectKeys, providerTaskIds, cancelRequested, ...safe } = job;
  return safe;
}

function normalizeOptions(value) {
  let input = value || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch (_) { input = {}; }
  }
  return {
    language: input.language || input.languageCode || 'zh',
    enablePunctuation: bool(input.enablePunctuation ?? input.punctuation, true),
    enableInverseTextNormalization: bool(input.enableInverseTextNormalization ?? input.normalizeNumbers, true),
    enableTimestamp: bool(input.enableTimestamp ?? input.timestamps, true),
    enableWordTimestamp: bool(input.enableWordTimestamp ?? input.wordLevel, true),
    enableDiarization: bool(input.enableDiarization ?? input.speakerRecognition ?? input.speakerDiarization, false),
    maxSpeakers: Math.max(1, Math.min(20, Number(input.maxSpeakers || 2))),
    vocabulary: input.vocabulary || input.hotwords || ''
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function ffmpegPath() { return process.env.FFMPEG_PATH || 'ffmpeg'; }
function ffprobePath() { return process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg(?:\.exe)?$/i, 'ffprobe') : 'ffprobe'); }

async function probeVideo(videoPath) {
  const result = await runProcess(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', videoPath]);
  const info = JSON.parse(result.stdout || '{}');
  const streams = info.streams || [];
  const duration = Number(info.format?.duration || 0);
  return { duration, hasAudio: streams.some((stream) => stream.codec_type === 'audio') };
}

async function extractAudioChunks(videoPath, workDir, duration) {
  const starts = [];
  if (duration <= CHUNK_SECONDS + 0.5) starts.push(0);
  else for (let start = 0; start < duration; start += CHUNK_SECONDS) starts.push(start);
  const chunks = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const length = Math.min(CHUNK_SECONDS + CHUNK_OVERLAP_SECONDS, duration - start);
    const output = path.join(workDir, `audio-${String(index + 1).padStart(3, '0')}.wav`);
    await runProcess(ffmpegPath(), ['-y', '-i', videoPath, '-ss', String(start), '-t', String(length), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
    chunks.push({ path: output, offsetMs: Math.round(start * 1000), durationSeconds: length });
  }
  return chunks;
}

function isDemoMode() {
  return bool(process.env.DEMO_MODE, false) || !(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET && process.env.ALIYUN_NLS_APP_KEY && process.env.ALIYUN_OSS_BUCKET);
}

function escapedFilename(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120); }
function throwIfCancelled(job) { if (job.cancelRequested) throw Object.assign(new Error('任务已取消'), { cancelled: true }); }
async function delayWithCancellation(ms, job) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfCancelled(job);
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
  throwIfCancelled(job);
}

class AliyunProvider {
  constructor() {
    this.demo = isDemoMode();
    this.appKey = process.env.ALIYUN_NLS_APP_KEY;
    this.region = process.env.ALIYUN_REGION || 'cn-shanghai';
    this.endpoint = process.env.ALIYUN_FILETRANS_ENDPOINT || `https://nls-filetrans.${this.region}.aliyuncs.com`;
    this.bucket = process.env.ALIYUN_OSS_BUCKET;
    this.prefix = process.env.ALIYUN_OSS_PREFIX || 'transcriber-temp/';
    this.oss = null;
    this.core = null;
    if (!this.demo) {
      try {
        const OSS = require('ali-oss');
        this.oss = new OSS({ region: process.env.ALIYUN_OSS_REGION || this.region, bucket: this.bucket, accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, secure: true });
        const Core = require('@alicloud/pop-core');
        this.core = new Core({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, endpoint: this.endpoint, apiVersion: '2018-08-17' });
      } catch (error) {
        this.demo = true;
        this.initError = `阿里云依赖不可用：${error.message}`;
      }
    }
  }

  async uploadAudio(filePath, jobId, index) {
    if (this.demo) return { objectKey: `demo/${jobId}/${index}.wav`, fileLink: `demo://audio/${jobId}/${index}` };
    const objectKey = `${this.prefix}${jobId}/${index}-${escapedFilename(path.basename(filePath))}`;
    await this.oss.put(objectKey, filePath, { headers: { 'x-oss-object-acl': 'private' } });
    const fileLink = this.oss.signatureUrl(objectKey, { expires: 1800, method: 'GET' });
    return { objectKey, fileLink };
  }

  async submitTask(fileLink, options) {
    if (this.demo) return { taskId: `demo-task-${uid()}` };
    const task = {
      appkey: this.appKey,
      file_link: fileLink,
      version: '4.0',
      enable_timestamp: options.enableTimestamp,
      enable_words: options.enableWordTimestamp,
      enable_diarization: options.enableDiarization,
      speaker_count: options.maxSpeakers,
      enable_punctuation_prediction: options.enablePunctuation,
      enable_inverse_text_normalization: options.enableInverseTextNormalization,
      language: options.language,
      vocabulary: Array.isArray(options.vocabulary) ? options.vocabulary.join(',') : options.vocabulary
    };
    const response = await this.core.request('SubmitTask', { Task: JSON.stringify(task) }, { method: 'POST' });
    const taskId = response?.TaskId || response?.Task?.TaskId || response?.Data?.TaskId;
    if (!taskId) throw new Error(`阿里云 SubmitTask 未返回 TaskId：${JSON.stringify(response)}`);
    return { taskId, raw: response };
  }

  async pollTask(taskId, onProgress, job) {
    if (this.demo) {
      for (let progress = 20; progress <= 100; progress += 20) {
        await delayWithCancellation(350, job);
        onProgress?.(progress);
      }
      return { status: 'SUCCESS', result: demoSegments() };
    }
    const deadline = Date.now() + Number(process.env.ALIYUN_TIMEOUT_MS || 60 * 60 * 1000);
    while (Date.now() < deadline) {
      throwIfCancelled(job);
      const response = await this.core.request('GetTaskResult', { TaskId: taskId }, { method: 'GET' });
      const status = response?.StatusText || response?.Status || response?.Data?.StatusText;
      if (status === 'SUCCESS' || status === 'SUCCESS_WITH_WARNING') return { status, result: response?.Result || response?.Data?.Result || response, raw: response };
      if (status === 'FAILED' || status === 'ERROR') throw new Error(response?.ErrorMessage || response?.Message || '阿里云转写失败');
      onProgress?.(Math.min(95, Number(response?.Progress || response?.Data?.Progress || 40)));
      await delayWithCancellation(Number(process.env.ALIYUN_POLL_INTERVAL_MS || 3000), job);
    }
    throw new Error('阿里云转写任务超时');
  }

  async removeObject(objectKey) {
    if (!this.demo && objectKey) await this.oss.delete(objectKey).catch(() => {});
  }
}

function demoSegments() {
  return [{ startMs: 0, endMs: 4200, speaker: '说话人 1', text: '这是演示模式生成的转写结果。', confidence: 0.98, words: [{ startMs: 0, endMs: 1300, text: '这是', confidence: 0.99 }, { startMs: 1300, endMs: 2600, text: '演示模式', confidence: 0.98 }, { startMs: 2600, endMs: 4200, text: '生成的转写结果。', confidence: 0.97 }] }, { startMs: 4600, endMs: 8000, speaker: '说话人 1', text: '你可以在结果页校对内容并导出字幕。', confidence: 0.96 }];
}

function parseProviderResult(result, offsetMs = 0) {
  if (Array.isArray(result)) return result.map((item) => ({ ...item, startMs: Number(item.startMs || 0) + offsetMs, endMs: Number(item.endMs || item.startMs || 0) + offsetMs }));
  const source = result?.Sentences || result?.sentences || result?.Transcription || result?.transcription || result?.Result || [];
  if (Array.isArray(source)) return source.map((item) => ({ startMs: Number(item.BeginTime ?? item.beginTime ?? item.StartTime ?? item.startMs ?? 0) + offsetMs, endMs: Number(item.EndTime ?? item.endTime ?? item.EndTimeMs ?? item.endMs ?? 0) + offsetMs, speaker: item.SpeakerId || item.speaker, text: item.Text || item.text || '', confidence: Number(item.Confidence ?? item.confidence ?? 0) || undefined, words: (item.Words || item.words || []).map((word) => ({ startMs: Number(word.BeginTime ?? word.startMs ?? 0) + offsetMs, endMs: Number(word.EndTime ?? word.endMs ?? 0) + offsetMs, text: word.Text || word.text || '', confidence: Number(word.Confidence ?? word.confidence ?? 0) || undefined })) }));
  if (typeof result === 'string') return [{ startMs: offsetMs, endMs: offsetMs + 1000, text: result }];
  return [];
}

function mergeSegments(segments) {
  return segments.filter((segment) => segment.text).sort((a, b) => a.startMs - b.startMs).reduce((merged, current) => {
    const previous = merged[merged.length - 1];
    if (previous && current.startMs < previous.endMs && current.text.trim() === previous.text.trim()) {
      previous.endMs = Math.max(previous.endMs, current.endMs);
      return merged;
    }
    if (previous && current.startMs < previous.endMs) {
      const priorText = previous.text.trim();
      const currentText = current.text.trim();
      if (currentText.startsWith(priorText) && currentText.length > priorText.length) {
        current.text = currentText.slice(priorText.length).trim();
      } else if (priorText.length > 4 && currentText.startsWith(priorText.slice(-Math.min(12, priorText.length)))) {
        current.text = currentText.slice(Math.min(12, priorText.length)).trim() || current.text;
      }
    }
    merged.push({ ...current });
    return merged;
  }, []);
}

function formatTime(ms, separator = ',') {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(value / 3600000); const minutes = Math.floor((value % 3600000) / 60000); const seconds = Math.floor((value % 60000) / 1000); const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function exportText(job, format) {
  const segments = job.segments || [];
  if (format === 'json') return { contentType: 'application/json; charset=utf-8', extension: 'json', body: JSON.stringify({ jobId: job.id, title: job.originalName, segments }, null, 2) };
  if (format === 'srt') return { contentType: 'application/x-subrip; charset=utf-8', extension: 'srt', body: segments.map((segment, index) => `${index + 1}\n${formatTime(segment.startMs)} --> ${formatTime(segment.endMs)}\n${segment.speaker ? `[${segment.speaker}] ` : ''}${segment.text}\n`).join('\n') };
  if (format === 'vtt') return { contentType: 'text/vtt; charset=utf-8', extension: 'vtt', body: `WEBVTT\n\n${segments.map((segment) => `${formatTime(segment.startMs, '.')} --> ${formatTime(segment.endMs, '.')}\n${segment.speaker ? `[${segment.speaker}] ` : ''}${segment.text}\n`).join('\n')}` };
  return { contentType: 'text/plain; charset=utf-8', extension: 'txt', body: segments.map((segment) => `${segment.speaker ? `[${segment.speaker}] ` : ''}${segment.text}`).join('\n') };
}

async function safeRemove(filePath) { if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {}); }
async function cleanupJob(job, provider) { for (const objectKey of job.objectKeys || []) await provider.removeObject(objectKey); for (const filePath of [job.sourcePath, ...(job.audioPaths || [])]) await safeRemove(filePath); await fsp.rm(path.join(TEMP_DIR, job.id), { recursive: true, force: true }).catch(() => {}); }

async function processJob(job) {
  const provider = new AliyunProvider();
  try {
    job.stage = 'extracting'; job.progress = 8; await writeJob(job);
    // 演示模式保留完整的阶段状态机，但不要求本机安装 FFmpeg 或配置云端凭据。
    if (provider.demo) {
      let demoProbe;
      try {
        demoProbe = await probeVideo(job.sourcePath);
        if (!demoProbe.hasAudio) throw new Error('视频没有可用的音频轨道');
        if (!demoProbe.duration || demoProbe.duration > MAX_DURATION_SECONDS) throw new Error(`视频时长超过限制（${Math.round(MAX_DURATION_SECONDS / 60)} 分钟）`);
      } catch (error) {
        // 演示环境可以没有 FFprobe；若工具不可用，继续模拟，但保留可识别的业务校验错误。
        if (error.message === '视频没有可用的音频轨道' || error.message.startsWith('视频时长超过限制')) throw error;
      }
      await delayWithCancellation(300, job);
      job.durationMs = Math.round((demoProbe?.duration || 8) * 1000); job.stage = 'uploading'; job.progress = 32; await writeJob(job);
      await delayWithCancellation(300, job);
      job.stage = 'transcribing'; job.progress = 58; await writeJob(job);
      await delayWithCancellation(700, job);
      job.segments = demoSegments(); job.stage = 'completed'; job.progress = 100; job.completedAt = now(); await writeJob(job);
      await cleanupJob(job, provider);
      return;
    }
    const probe = await probeVideo(job.sourcePath);
    if (!probe.hasAudio) throw new Error('视频没有可用的音频轨道');
    if (!probe.duration || probe.duration > MAX_DURATION_SECONDS) throw new Error(`视频时长超过限制（${Math.round(MAX_DURATION_SECONDS / 60)} 分钟）`);
    job.durationMs = Math.round(probe.duration * 1000);
    const workDir = path.join(TEMP_DIR, job.id); await fsp.mkdir(workDir, { recursive: true });
    job.audioPaths = (await extractAudioChunks(job.sourcePath, workDir, probe.duration)).map((chunk) => chunk.path); await writeJob(job);
    job.stage = 'uploading'; job.progress = 28; await writeJob(job);
    const chunks = [];
    for (let index = 0; index < job.audioPaths.length; index += 1) {
      if (job.cancelRequested) throw Object.assign(new Error('任务已取消'), { cancelled: true });
      const offsetMs = Math.min(probe.duration * 1000, index * CHUNK_SECONDS * 1000);
      const uploaded = await provider.uploadAudio(job.audioPaths[index], job.id, index + 1);
      job.objectKeys = [...(job.objectKeys || []), uploaded.objectKey]; await writeJob(job);
      chunks.push({ ...uploaded, offsetMs }); job.progress = 30 + Math.round((index / job.audioPaths.length) * 20); await writeJob(job);
    }
    job.stage = 'transcribing'; job.progress = 52; await writeJob(job);
    const allSegments = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (job.cancelRequested) throw Object.assign(new Error('任务已取消'), { cancelled: true });
      const task = await provider.submitTask(chunks[index].fileLink, job.options); job.providerTaskIds = [...(job.providerTaskIds || []), task.taskId]; await writeJob(job);
      const result = await provider.pollTask(task.taskId, (innerProgress) => { job.progress = Math.min(98, 52 + Math.round(((index + innerProgress / 100) / chunks.length) * 46)); writeJob(job).catch(() => {}); }, job);
      if (result.raw) job.rawProviderResponse = result.raw;
      allSegments.push(...parseProviderResult(result.result, chunks[index].offsetMs));
    }
    job.segments = mergeSegments(allSegments); job.stage = 'completed'; job.progress = 100; job.completedAt = now(); await writeJob(job); await cleanupJob(job, provider);
  } catch (error) {
    job.stage = error.cancelled || job.cancelRequested ? 'cancelled' : 'error'; job.error = error.message; await writeJob(job); await cleanupJob(job, provider);
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: MAX_FILE_SIZE }, fileFilter: (_req, file, callback) => { const extension = path.extname(file.originalname).toLowerCase(); callback(null, VIDEO_EXTENSIONS.has(extension)); } });

app.get('/api/health', (_req, res) => res.json({ ok: true, demoMode: isDemoMode(), version: APP_VERSION }));
app.get('/api/config', (_req, res) => res.json({
  version: APP_VERSION,
  demoMode: isDemoMode(),
  provider: 'aliyun-filetrans',
  region: process.env.ALIYUN_REGION || 'cn-shanghai',
  limits: { maxFileSize: MAX_FILE_SIZE, maxDurationSeconds: MAX_DURATION_SECONDS }
}));
app.get('/api/jobs', (_req, res) => res.json({ jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob) }));
app.post('/api/jobs', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 MP4、MOV、AVI、MKV、M4V 或 WebM 视频文件' });
  const job = { id: uid(), stage: 'video_selected', progress: 2, originalName: req.file.originalname, fileSize: req.file.size, createdAt: now(), updatedAt: now(), sourcePath: req.file.path, options: normalizeOptions(req.body.options || req.body), segments: [], objectKeys: [], providerTaskIds: [] };
  await writeJob(job); processJob(job).catch(() => {}); res.status(202).json({ jobId: job.id, job: publicJob(job), demoMode: isDemoMode() });
});
app.get('/api/jobs/:id', (req, res) => { const job = jobs.get(req.params.id); if (!job) return res.status(404).json({ error: '任务不存在' }); res.json(publicJob(job)); });
app.post('/api/jobs/:id/cancel', async (req, res) => { const job = jobs.get(req.params.id); if (!job) return res.status(404).json({ error: '任务不存在' }); job.cancelRequested = true; if (['completed', 'error', 'cancelled'].includes(job.stage)) job.stage = 'cancelled'; await writeJob(job); res.json(publicJob(job)); });
app.patch('/api/jobs/:id/result', async (req, res) => { const job = jobs.get(req.params.id); if (!job) return res.status(404).json({ error: '任务不存在' }); if (!Array.isArray(req.body.segments)) return res.status(400).json({ error: 'segments 必须是数组' }); job.segments = req.body.segments.map((segment) => ({ startMs: Number(segment.startMs) || 0, endMs: Number(segment.endMs) || 0, speaker: segment.speaker || undefined, text: String(segment.text || ''), confidence: segment.confidence === undefined ? undefined : Number(segment.confidence), words: Array.isArray(segment.words) ? segment.words : undefined })); job.editedAt = now(); await writeJob(job); res.json(publicJob(job)); });
app.get('/api/jobs/:id/export', (req, res) => { const job = jobs.get(req.params.id); if (!job) return res.status(404).json({ error: '任务不存在' }); const format = String(req.query.format || 'txt').toLowerCase(); if (!['txt', 'srt', 'vtt', 'json'].includes(format)) return res.status(400).json({ error: '不支持的导出格式' }); const result = exportText(job, format); res.setHeader('Content-Type', result.contentType); res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((job.originalName || job.id).replace(/\.[^.]+$/, ''))}.${result.extension}"`); res.send(result.body); });

app.use(express.static(PUBLIC_DIR));
app.use((error, _req, res, _next) => { if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '视频文件超过大小限制' }); if (error) return res.status(400).json({ error: error.message || '请求失败' }); return res.status(404).json({ error: '资源不存在' }); });

async function start() { await loadJobs(); return app.listen(PORT, () => console.log(`视频音频转文本服务已启动：http://localhost:${PORT}`)); }
if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { app, start, exportText, formatTime, mergeSegments, normalizeOptions, parseProviderResult, probeVideo, isDemoMode, STAGES };
