# VoiceCan Studio application

本目录是仓库中唯一的应用。External 与 Local Full 是同一应用的两个部署配置：

```text
Recording → Audio → Transcript Revision → Summary Revision → Confirmation → Delivery
```

- **External**：真实 Device Platform + HTTP ASR + HTTP Summary；Courier 通知可选。
- **Local Full**：真实 Device Platform + 内嵌 Faster-Whisper + Qwen3-4B GGUF；Courier 默认关闭。

完整安装、配置、Doctor 和运维步骤见 [RUNBOOK.zh-CN.md](RUNBOOK.zh-CN.md)。仓库入口、发布状态和许可证说明见 [../README.md](../README.md)。

## 开发

```bash
cd ..
npm ci
npm run build
npm run test
npm run dev:external
# 或 npm run dev:local-full
```

应用固定使用公开 Device Platform SDK 和 Courier 官方 Node SDK。生产入口不包含 Fixture，也不实现 Slack、Teams、邮件、短信等渠道协议。

需要由 AI 添加或修改能力时，先阅读 [AGENTS.md](AGENTS.md) 和 [docs/ai-development/START-HERE.md](docs/ai-development/START-HERE.md)。
