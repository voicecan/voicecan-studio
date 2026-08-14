# AI 开发入口

这份文档让 AI 在不读取真实运行数据的情况下安全扩展 Voicecan Studio。

## 1. 先确定边界

Device Platform 已经拥有设备、录音、授权、命令、固件和 Platform 运维能力。不要在 Studio 再做一遍。Studio 的输入是授权 Recording，输出是可审核、可执行的应用结果。

```text
Platform Source → Processor → Artifact → Scenario → Review → Action
```

固定阅读顺序：

1. 仓库根 `AGENTS.md` 与 `studio/AGENTS.md`。
2. 本文件、`EXTENSION-CATALOG.md` 和一条对应 Recipe。
3. 只读取该扩展点列出的代码、Contract 和测试。
4. 写下输入/输出 Contract、Revision/stale 语义、Secret/网络影响、失败路径和验证命令。

禁止默认读取 `.env`、`data/`、`work/`、`models/`、真实 SQLite、音频、Transcript、Delivery Payload 或私有协议运行时内部实现。

## 2. 选择最小扩展点

| 目标 | 选择 | 命令 |
| --- | --- | --- |
| 增加新的业务应用场景 | Scenario Pack | `npm run generate:scenario -- --name <id> --title <title>` |
| 更换 ASR 或总结模型 | Processor Stage | `npm run generate:processor -- --name <id> --kind asr\|summary` |
| 对接工单、CRM、通知等第三方平台 | Integration | `npm run generate:integration -- --name <id> --sdk <official-sdk>` |
| 改变事务、不变量或数据所有权 | Internal Capability | `npm run generate:capability -- --name <id>` |

如果只是改变结构化输出和 UI 展示，优先 Scenario Pack；不要创建新的 Platform 服务或复制录音生命周期代码。

## 3. 不变量

- 一条 Recording 只下载、转写一次；切换 Scenario 不得重新下载或转写。
- 每个 Artifact 有 hash、producer、parent IDs 和源 Recording resource version。
- Scenario Result 必须引用存在的 Transcript segment，并绑定当前 Transcript/Summary Revision。
- 上游变化后，旧 Scenario 变 stale、审核失效、未执行 Action 被取消。
- Action 必须先生成 Preview，再由操作者显式执行；提交必须幂等。
- 第三方能力只使用官方 SDK。渠道能力由 Courier 管理，不实现逐渠道 Transport。
- SDK 类型只留在 `platform/` 或 `integrations/`，不会进入 Scenario/Domain Contract。

## 4. 代码入口

| 扩展 | 先读 | 必测 |
| --- | --- | --- |
| Scenario | `src/scenarios/types.ts`、`builtins.ts`、`registry.ts` | 默认选择、字段校验、引用、切换不重转写、stale |
| Processor | `src/shared/processor.ts` 或 `src/summary-processor.ts` | ready、超时、响应上限、错误映射、输出校验 |
| Integration | `src/notification-provider.ts`、目标 Port | 官方 SDK typed API、Secret 脱敏、幂等、429/5xx、状态同步 |
| API/UI | `src/web.ts`、`src/studio-page.ts` | Operator auth、Revision conflict、窄屏和真实浏览器 |

## 5. 完成定义

```bash
npm run build
npm run check:architecture
npm run check:boundaries
npm test
```

同时确认：External 与 Local Full 都能启动；Fixture 不能被生产入口选择；文档、示例配置和 UI 用词不把 Studio 描述成 Device Platform；新增网络出口和 Secret 已明确；至少包含一个失败路径测试。
