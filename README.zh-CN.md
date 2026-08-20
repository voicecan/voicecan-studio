# Voicecan Studio

[English](README.md)

Voicecan Studio 是一个自托管语音工作流应用：把经过授权的 Voicecan 录音转换为结构化结果，交给人工审核，并帮助操作者安全地执行后续动作。它连接 [Voicecan Device Platform](https://github.com/voicecan/device-platform)，提供简单的 Web 界面和两种处理档位。

```text
Recording → Transcript → Summary → Scenario result → Review → Action
```

## 你可以做什么

- 一次处理授权录音，并把 Transcript、Summary、Scenario、审核和动作关联起来。
- 在内置工作流之间切换，无需重复下载或转写同一条录音。
- 查看带来源引用的结果，编辑内容，并在确认当前结果后执行动作。
- 通过 Courier 预览和提交通知，并获得可重试的投递和 Provider 状态回写。
- 使用外部模型服务，或通过 Local Full 在本地完成处理。
- 添加自己的 Scenario Pack、Processor 和第三方 Integration。

## 内置工作流

| 工作流 | 适用场景 | 典型产出 |
| --- | --- | --- |
| Voice Inbox | 个人备忘和语音收件箱 | 分类、标签、任务和后续动作 |
| Field Report | 现场走访和外勤工作 | 现场发现、严重度、跟进标记和建议 |
| Meeting / Interview | 会议、访谈和对话 | 带来源引用的议题、决策和行动项 |

## 选择处理档位

| 档位 | 处理方式 | 通知 | 适合 |
| --- | --- | --- | --- |
| External | 连接 HTTP ASR 和 Summary 服务 | Courier，可选 | 已有模型服务或共享部署 |
| Local Full | 内嵌 Faster-Whisper 和 Qwen3-4B GGUF Worker | 默认关闭，可启用 | 本地或离线处理 |

两个档位共用同一套 Web 界面和工作流模型，切换处理档位不会改变用户操作方式。

## 快速开始

要求 Node.js `24.19.0` 或更新的 24.x 版本，并准备一个运行中的 Device Platform 实例。

```bash
npm ci
npm run build
npm run start:external
```

External 首次启动时，打开 `http://127.0.0.1:8811`，在 Setup 页面填写 Device Platform、ASR、Summary 和可选 Courier 配置。

Linux 运行 Local Full：

```bash
cd studio
bash scripts/setup-local-linux.sh
bash scripts/run-local-linux.sh
```

Windows 使用 `scripts/setup-local-windows.ps1` 和 `scripts/run-local-windows.ps1`。安装器会准备本地音频工具和模型。

Docker 用户可以选择任一档位：

```bash
docker compose -f compose.external.yml up --build
docker compose -f compose.local-full.yml up --build
```

## 让 AI 一键配置

将下面的 Prompt 复制给 ChatGPT、Codex、Claude 或其他 AI 编程/自动化助手，即可让它按录音工作流配置 Studio：

```text
你正在为当前环境配置 https://github.com/voicecan/voicecan-studio 中的 Voicecan Studio。

把用户当前请求作为配置或接入目标。执行前先读取并遵守仓库指导和相关扩展 Recipe：

https://github.com/voicecan/voicecan-studio/blob/main/AGENTS.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/AGENTS.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/docs/ai-development/START-HERE.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/docs/ai-development/EXTENSION-CATALOG.md
https://github.com/voicecan/voicecan-studio/tree/main/studio/docs/ai-development/recipes

如果需要接入 Device Platform，再读取 https://github.com/voicecan/device-platform/tree/main/skills 中相关的 Skills。

先检查环境和已有 Studio 进程。按照仓库指导处理档位选择、配置、测试数据、凭据、工作流验证和扩展范围。使用公开 Device Platform Contract，不要重复建设设备管理能力。

不得读取或暴露 Secret、生产录音、音频、Transcript、Delivery Payload、私有协议源码或模型文件。外部网络变更、发送通知、修改保留策略、删除数据、创建凭据或修改已有部署前必须先询问确认。完成后报告档位、本地 URL、命令、检查结果、人工步骤、配置变更和回滚方案，不得包含 Secret 或用户内容。
```

## 隐私与动作安全

Studio 不负责设备管理：设备身份、录音授权和下载由 Device Platform 提供。动作执行分为两步，先预览，再由操作者显式确认。默认 Action Payload 不包含音频、下载 URL 或完整 Transcript。

Local Full 默认关闭 Courier，因此本地环境可以在不发送通知的情况下完成审核、预览和 Markdown 导出。

## 扩展 Studio

推荐的扩展点包括：

- **Scenario Pack**：增加新的用户工作流和结果格式。
- **Processor Stage**：接入 ASR 或 Summary 服务。
- **Integration**：接入受支持的第三方动作服务。

详见[架构说明](docs/ARCHITECTURE.md)、[AI 开发入口](studio/docs/ai-development/START-HERE.md)和[运行手册](studio/RUNBOOK.zh-CN.md)。

## 更多资料

- [公开发布检查表](docs/PUBLIC_RELEASE_CHECKLIST.md)
- [安全策略](SECURITY.md)
- [支持](SUPPORT.md)
- [参与贡献](CONTRIBUTING.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
