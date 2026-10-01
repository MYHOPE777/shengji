# 视频音频转文本工作台

当前版本：**v1.0.0**

这是一个单用户本地部署的中文视频转写工作台：先用 FFmpeg 从视频中提取 16 kHz、单声道 WAV，再通过阿里云 OSS 临时地址提交 FileTrans 录音文件识别。结果可人工校对并导出 TXT、SRT、VTT 或 JSON。

## 运行环境

- Node.js 18 或更高版本
- FFmpeg 与 FFprobe（真实模式需要；Windows 可将可执行文件加入 PATH）
- 阿里云真实模式需要 OSS 私有 Bucket、RAM 最小权限账号和 NLS AppKey

安装依赖：

```powershell
npm install --registry=https://registry.npmmirror.com
```

复制 `.env.example` 为 `.env`。没有完整阿里云配置时，服务会自动显示“演示模式”，上传后走可验证的模拟阶段和示例结果；设置 `DEMO_MODE=false` 且补齐阿里云变量后才会调用真实服务。

启动：

```powershell
npm start
```

浏览器打开 `http://localhost:3000`。本项目不会自动启动服务。

## 真实服务配置

服务端会把抽取音频放进 OSS 私有目录，生成约 30 分钟的 HTTPS 签名地址，然后调用 `SubmitTask` 并轮询 `GetTaskResult`。任务完成、失败或取消后会删除临时对象。长视频会按 10 分钟切片，并保留 2 秒重叠，以便失败重试和时间戳合并。

AccessKey Secret 不会发送到浏览器，也不会写入任务 JSON、转写结果或导出文件。生产环境应使用 RAM 子账号/角色、限制 OSS Bucket 权限并配置生命周期清理。

## 接口

- `POST /api/jobs`：multipart 上传字段 `video`，可附带 `options` JSON
- `GET /api/jobs/:id`：读取任务阶段、进度和转写分段
- `POST /api/jobs/:id/cancel`：取消任务
- `PATCH /api/jobs/:id/result`：保存编辑后的 `segments`
- `GET /api/jobs/:id/export?format=txt|srt|vtt|json`：导出结果
- `GET /api/config`：仅返回演示/真实模式和非敏感限制信息

## 验证

```powershell
npm test
```

测试覆盖时间码、四种导出格式、重叠片段去重、选项归一化和阿里云结果映射。未配置云端时可直接在演示模式验证完整前端流程。

## GitHub 更新

首次配置远程仓库后，后续更新依次执行：

git add .
git commit -m "描述本次更新"
git push origin main

发布新版本时同步更新 package.json 中的 version，并创建版本标签：

git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
