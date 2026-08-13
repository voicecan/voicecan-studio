# VoiceCan Studio

VoiceCan Studio 是一个可独立部署、可直接扩展的 Device Platform 场景应用示例。仓库中只有这一个 Demo，并提供两种部署配置：

```text
Authorized Recording → Processor Stages → Traceable Artifacts → Scenario Pack → Human Review → Action Intent
```

Device Platform 负责设备、录音、授权和下载；Studio 不重复建设这些管理能力。Studio 从授权 Recording 开始，完成处理、场景投影、人工审核、动作预览和 Courier 执行。一条 Recording 只下载和转写一次；上游 Revision 变化会让下游结果失效并阻止执行。

> 当前状态：首次公开发布候选。正式公开前必须完成 [公开发布检查表](docs/PUBLIC_RELEASE_CHECKLIST.md)，尤其是补充仓库许可证及两个 VoiceCan SDK 制品的许可证文件。

## 两种发行档位

| 档位 | 模型处理 | 通知出口 | 默认端口 |
| --- | --- | --- | ---: |
| External | HTTP ASR + HTTP Summary Processor | Courier，可选 | `8811` |
| Local Full | 内嵌 Faster-Whisper + 内嵌 Qwen3-4B GGUF Worker | 默认关闭；可显式启用 Courier | `8815` |

两个档位共享同一套场景模型、Web UI 和 API，只在 Composition Root 选择不同的 Processor。生产入口不包含 Fixture Processor。

## 内置可执行场景

| Scenario Pack | 默认 Recording attribute | 产出 |
| --- | ---: | --- |
| Voice Inbox | `0` | 备忘分类、标签、任务和后续动作 |
| Field Report | `1` | 现场发现、严重度、跟进标记和处置建议 |
| Meeting / Interview | `2` | 带原文引用的议题、决策和行动项 |

场景可以随时切换而不重新下载或转写。每次投影、编辑和审核都有 Revision；动作必须先生成预览，再由操作者显式确认执行。

## 快速开始

```bash
npm ci
npm run build
npm run start:external
```

要求 Node.js `24.19.0` 或更新的 24.x 版本。首次启动 External 且配置缺失时，打开 `http://127.0.0.1:8811`，在 Setup 页面配置 Device Platform、ASR、Summary 和可选 Courier。配置会先验证，再以权限 `0600` 原子写入。

Local Full：

```bash
cd studio
bash scripts/setup-local-linux.sh
bash scripts/run-local-linux.sh
```

Windows 使用 `scripts/setup-local-windows.ps1` 和 `scripts/run-local-windows.ps1`。安装器准备 Node、uv、FFmpeg、liblc3、固定 ASR 模型以及固定的 `Qwen/Qwen3-4B-GGUF@34778e…` Q4_K_M Summary 模型；模型安装后按大小和 SHA-256 校验。Local Full 最低基线为 8 GiB RAM、4 GiB Summary 模型可用磁盘，实际长录音建议 16 GiB RAM。

Docker：

```bash
docker compose -f compose.external.yml up --build
docker compose -f compose.local-full.yml up --build
```

完整安装和运维说明见 [运行手册](studio/RUNBOOK.zh-CN.md)。架构、扩展点和边界见 [架构说明](docs/ARCHITECTURE.md)。

## 动作执行与多渠道

Studio 固定使用 Courier 官方 Node SDK `@trycourier/courier@7.25.0`。Studio 只管理 Action Intent、发送预览、幂等提交和 Provider 状态同步；email、SMS、push、chat、inbox 的 Integration、Template、Routing、Preference、重试和日志由 Courier 管理。仓库不实现逐渠道 Transport 或 Adapter。

执行前必须人工确认当前 Scenario Revision。默认 Payload 不包含音频、下载 URL 或完整 Transcript。Local Full 的 `NOTIFICATION_ENABLED=false` 为默认值；严格零外联环境仍可审核、预览和导出 Markdown。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev:external` | External 开发入口 |
| `npm run dev:local-full` | Local Full 开发入口 |
| `npm run doctor` | CLI Doctor |
| `npm run verify:sdk` | 校验审查过的 Device Platform SDK 制品 |
| `npm run check:boundaries` | 检查私有 Core、Fixture 和渠道边界 |
| `npm run check:architecture` | 检查 Capability 分层依赖 |
| `npm run ci` | 完整构建和测试门禁 |
| `npm run generate:scenario -- --name <id> --title <title>` | 生成并注册 Scenario Pack |
| `npm run generate:processor -- --name <id> --kind asr\|summary` | 生成 Processor 骨架 |
| `npm run generate:integration -- --name <id> --sdk <package>` | 生成官方 SDK Integration 骨架 |
| `npm run generate:capability -- --name <id>` | 生成底层内部 Capability 骨架 |
| `npm run context:ai -- --capability <id>` | 输出 AI 最小安全上下文 |
| `npm run verify:change -- --capability <id>` | 定向验证改动 |

## AI 添加或修改功能

先阅读 [studio/AGENTS.md](studio/AGENTS.md)、[AI Start Here](studio/docs/ai-development/START-HERE.md) 和 [Extension Catalog](studio/docs/ai-development/EXTENSION-CATALOG.md)。面向用户的首选扩展点是 Scenario Pack、Processor Stage 和 Integration；内部 Capability 只承载稳定事务边界。AI 不需要通读仓库，也不得读取 `.env`、真实 SQLite、音频、Transcript 或 Delivery Payload。

## 安全边界

- 只通过公开 `@voicecan/server-client` 使用 Device Platform；不访问 Device Core 私有源码、Platform 数据库或对象存储凭证。
- Application Token、Webhook Secret、Processor/Courier Key、临时 URL、音频和内容不写日志。
- Download Grant 只在任务取得执行权且 Processor、音频工具、存储健康后创建。
- 所有写 API 使用 Operator Token；浏览器仅把 Token 保存到当前 Session。
- 默认监听 `127.0.0.1`。对公网部署前必须使用带认证的 TLS Ingress。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告；普通问题见 [SUPPORT.md](SUPPORT.md)，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。第三方依赖与待确认授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
