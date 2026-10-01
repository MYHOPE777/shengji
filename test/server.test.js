const test = require('node:test');
const assert = require('node:assert/strict');

const {
  exportText,
  formatTime,
  mergeSegments,
  normalizeOptions,
  parseProviderResult
} = require('../server');

test('formatTime formats milliseconds for SRT and VTT', () => {
  assert.equal(formatTime(0), '00:00:00,000');
  assert.equal(formatTime(3723123), '01:02:03,123');
  assert.equal(formatTime(-10), '00:00:00,000');
  assert.equal(formatTime(3723123, '.'), '01:02:03.123');
});

test('exportText generates TXT with speaker labels', () => {
  const result = exportText({ id: 'job-1', originalName: '会议.mp4', segments: [
    { startMs: 0, endMs: 1200, speaker: '说话人 1', text: '第一句' },
    { startMs: 1500, endMs: 2600, text: '第二句' }
  ] }, 'txt');

  assert.equal(result.extension, 'txt');
  assert.equal(result.contentType, 'text/plain; charset=utf-8');
  assert.equal(result.body, '[说话人 1] 第一句\n第二句');
});

test('exportText generates valid SRT numbering, timestamps, and text', () => {
  const result = exportText({ id: 'job-2', segments: [
    { startMs: 0, endMs: 1234, speaker: 'A', text: '你好' },
    { startMs: 60000, endMs: 61234, text: '第二句' }
  ] }, 'srt');

  assert.equal(result.extension, 'srt');
  assert.equal(result.contentType, 'application/x-subrip; charset=utf-8');
  assert.match(result.body, /^1\n00:00:00,000 --> 00:00:01,234\n\[A\] 你好\n\n2\n00:01:00,000 --> 00:01:01,234\n第二句\n$/);
});

test('exportText generates WEBVTT with dot-separated timestamps', () => {
  const result = exportText({ id: 'job-3', segments: [
    { startMs: 10, endMs: 1010, text: '字幕' }
  ] }, 'vtt');

  assert.equal(result.extension, 'vtt');
  assert.equal(result.contentType, 'text/vtt; charset=utf-8');
  assert.equal(result.body, 'WEBVTT\n\n00:00:00.010 --> 00:00:01.010\n字幕\n');
});

test('exportText generates JSON preserving segment fields', () => {
  const job = { id: 'job-4', originalName: 'sample.mp4', segments: [
    { startMs: 0, endMs: 500, text: '测试', confidence: 0.91, words: [{ startMs: 0, endMs: 500, text: '测试' }] }
  ] };
  const result = exportText(job, 'json');

  assert.equal(result.extension, 'json');
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.jobId, 'job-4');
  assert.equal(parsed.title, 'sample.mp4');
  assert.deepEqual(parsed.segments, job.segments);
});

test('mergeSegments removes duplicate overlap and keeps chronological order', () => {
  const result = mergeSegments([
    { startMs: 5000, endMs: 7000, text: '后一句' },
    { startMs: 0, endMs: 2000, text: '前一句' },
    { startMs: 1500, endMs: 2800, text: '前一句' },
    { startMs: 6500, endMs: 8000, text: '后一句' },
    { startMs: 9000, endMs: 9500, text: '' }
  ]);

  assert.deepEqual(result, [
    { startMs: 0, endMs: 2800, text: '前一句' },
    { startMs: 5000, endMs: 8000, text: '后一句' }
  ]);
});

test('mergeSegments trims repeated prefix in overlapping text', () => {
  const result = mergeSegments([
    { startMs: 0, endMs: 3000, text: '完整句子' },
    { startMs: 2500, endMs: 5000, text: '完整句子后半部分' }
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[1].text, '后半部分');
});

test('normalizeOptions applies defaults and clamps speaker count', () => {
  assert.deepEqual(normalizeOptions({}), {
    language: 'zh',
    enablePunctuation: true,
    enableInverseTextNormalization: true,
    enableTimestamp: true,
    enableWordTimestamp: true,
    enableDiarization: false,
    maxSpeakers: 2,
    vocabulary: ''
  });

  const options = normalizeOptions(JSON.stringify({
    languageCode: 'en',
    enablePunctuation: 'false',
    timestamps: 0,
    wordLevel: false,
    speakerRecognition: true,
    maxSpeakers: 99,
    hotwords: 'OpenAI'
  }));
  assert.deepEqual(options, {
    language: 'en',
    enablePunctuation: false,
    enableInverseTextNormalization: true,
    enableTimestamp: false,
    enableWordTimestamp: false,
    enableDiarization: true,
    maxSpeakers: 20,
    vocabulary: 'OpenAI'
  });
});

test('parseProviderResult maps Aliyun sentence and word timestamps with offsets', () => {
  const result = parseProviderResult({ Sentences: [{
    BeginTime: 100,
    EndTime: 900,
    SpeakerId: 'spk-1',
    Text: '你好',
    Confidence: 0.88,
    Words: [{ BeginTime: 100, EndTime: 400, Text: '你', Confidence: 0.9 }]
  }] }, 2000);

  assert.deepEqual(result, [{
    startMs: 2100,
    endMs: 2900,
    speaker: 'spk-1',
    text: '你好',
    confidence: 0.88,
    words: [{ startMs: 2100, endMs: 2400, text: '你', confidence: 0.9 }]
  }]);
});
