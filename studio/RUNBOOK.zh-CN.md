# VoiceCan Studio 运行手册

## 1. 选择档位

| 档位 | 模型链路 | 通知出口 | 端口 |
| --- | --- | --- | ---: |
| External | HTTP ASR + HTTP Summary | Courier，可选 | 8811 |
| Local Full | 本地 Faster-Whisper + 本地 Qwen3-4B GGUF | 默认关闭，可显式启用 | 8815 |

两个档位都必须连接真实 VoiceCan Device Platform。生产入口不提供模拟 Platform、模拟录音或 Fixture Processor。

## 2. External

```bash
cd /path/to/device-demo-app
npm ci
npm run build
npm run start:external
```

打开 `http://127.0.0.1:8811`。首次进入 Setup，填写 Device Platform URL、Application Token、Webhook Secret、HTTP ASR、HTTP Summary，以及可选 Courier API Key。配置只有在连接验证通过后才会以 `0600` 权限原子写入。

在 Device Platform 为该 Application 配置 Recording 读取、Download Grant 创建权限，并将 Webhook 指向：

```text
https://<studio-public-host>/webhooks/voicecan
```

公网入口必须由 TLS Ingress 保护。若 Studio 只绑定 `127.0.0.1`，需由反向代理转发 Webhook。

## 3. Local Full

Linux：

```bash
cd /path/to/device-demo-app/studio
bash scripts/setup-local-linux.sh
bash scripts/run-local-linux.sh
```

Windows PowerShell：

```powershell
cd D:\path\to\device-demo-app\studio
.\scripts\setup-local-windows.ps1
.\scripts\run-local-windows.ps1
```

安装器会准备音频工具、隔离的 Python 环境、固定 ASR 模型和固定 Qwen Summary 模型，并校验模型 Manifest、文件长度和 SHA-256。最低基线是 8 GiB RAM；推荐 16 GiB。模型只在安装阶段下载，运行阶段按本地路径加载。

严格零外联部署保持 `NOTIFICATION_ENABLED=false`，并应用 [deploy/network-policy.yaml](deploy/network-policy.yaml)。若管理员显式启用 Courier，应基于 [deploy/network-policy.courier-egress.yaml](deploy/network-policy.courier-egress.yaml) 配置附加出口策略并记录审批。

## 4. 配置和 Secret

环境变量模板见 [.env.example](.env.example)。至少配置：

- `VOICECAN_SERVER_URL`、`VOICECAN_APPLICATION_TOKEN`、`VOICECAN_WEBHOOK_SECRET`；
- External 的 `PROCESSOR_ENDPOINT`、`SUMMARY_ENDPOINT`；
- `DEMO_SETUP_TOKEN` 与 `DEMO_OPERATOR_TOKEN`；
- 启用通知时的 `COURIER_API_KEY`。

不要提交 `.env`、运行时 JSON、SQLite、模型、音频或内容数据。配置文件只存于受限运行目录；浏览器仅在当前 Session 保存 Operator Token。

## 5. 验收与诊断

```bash
cd /path/to/device-demo-app
npm run build
npm run doctor
npm run ci
```

Web UI 的 Setup 区也可运行 Doctor。正式验收至少覆盖：

1. Device Platform 授权 Recording 能作为来源被刷新；
2. 同一 Recording 只下载并转写一次；
3. 三个内置 Scenario 按 attribute 默认选择，并可切换而不重新转写；
4. Transcript 修改后下游 Artifact/Scenario 变为 stale 且审核失效；
5. 当前 Scenario 只有审核后才可创建 Action Preview，并需要再次显式执行；
6. 相同 Action Intent 重试不会重复提交，Courier 状态能回写；
7. Local Full 在禁网环境仍能完成转写、场景审核、预览和 Markdown 导出；
8. 上游删除产生 Tombstone，延迟事件不能复活数据。

## 6. 备份、升级和恢复

- 停止 Studio 后备份 `DEMO_DATABASE_PATH`、配置文件和模型 Manifest；不要把 Secret 放入普通日志归档。
- 发布新版本前执行 `npm run ci`，停止服务并备份运行目录；启动后检查健康状态和端到端场景。
- 同一数据库目录只允许一个 Studio 进程；锁冲突会以 `STUDIO_RUNTIME_LOCKED` 拒绝启动。
- Provider 返回结果未知时使用 Delivery 的 refresh/recover 操作，不要创建新的幂等键盲目重发。

## 7. AI 扩展

让 AI 修改功能时从 [docs/ai-development/START-HERE.md](docs/ai-development/START-HERE.md) 开始，优先通过 Scenario、Processor 或 Integration 生成器扩展；只有改变内部事务边界时才使用 Capability Catalog。

```bash
npm run context:ai -- --capability <name>
npm run verify:change -- --capability <name>
```
