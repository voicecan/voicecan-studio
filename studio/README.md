# Voicecan Studio 应用

本目录包含仓库中的 Voicecan Studio 应用。它从 Device Platform 获取授权录音，完成转写、摘要、场景整理、人工审核和动作预览。

Voicecan Studio 提供两个处理档位：

- **External**：使用 HTTP ASR 和 Summary 服务，Courier 通知可选。
- **Local Full**：使用内嵌 Faster-Whisper 和 Qwen3-4B GGUF Worker，Courier 默认关闭。

完整安装与运维步骤见 [RUNBOOK.zh-CN.md](RUNBOOK.zh-CN.md)，产品能力介绍见 [仓库 README](../README.md)。

## 开发

```bash
cd ..
npm ci
npm run build
npm run test
npm run dev:external
# 或 npm run dev:local-full
```

需要扩展用户工作流时，优先使用 Scenario Pack、Processor Stage 和 Integration。开发说明见 [AI 开发入口](docs/ai-development/START-HERE.md)。
