# Extension Catalog

## Scenario Packs

| ID | 默认 attribute | 结构化字段 | 动作 |
| --- | --- | --- | --- |
| `voice-inbox` | `0` | `category`、`task_count`、`tags` | `courier.notify` |
| `field-report` | `1` | `equipment_id`、`severity`、`finding_count`、`requires_follow_up` | `courier.notify` |
| `meeting-interview` | `2` | `topic_count`、`decision_count`、`action_count`、`source_segments` | `courier.notify` |

所有 Scenario Pack 都是纯 Projection，不下载音频、不调用模型、不访问数据库或网络。注册中心在 `src/scenarios/registry.ts`。

## Processor Stages

| Port | External | Local Full |
| --- | --- | --- |
| `TranscriptionProcessor` | `HttpTranscriptionProcessor` | `LocalAsrProcessor` |
| `SummaryProcessor` | `HttpSummaryProcessor` | `LocalSummaryProcessor` |

Processor 只产生已验证 Artifact，不了解 Courier 或具体 Scenario。

## Integrations

| Integration | SDK | 责任边界 |
| --- | --- | --- |
| Courier | `@trycourier/courier` | 提交场景通知、查询 History/Status、取消请求 |
| Device Platform source | `@voicecan/server-client` | 列出/读取/下载授权 Recording，验证 Webhook |

新增 Integration 必须使用厂商官方 SDK，并通过应用 Port 隔离。Courier 已经覆盖的 email、SMS、push、chat、inbox 等渠道只在 Courier 配置，不在仓库新增 Adapter。

## 生成器

```bash
npm run generate:scenario -- --name <lower-kebab-case> --title <title>
npm run generate:processor -- --name <lower-kebab-case> --kind asr|summary
npm run generate:integration -- --name <lower-kebab-case> --sdk <official-package>
```

生成器只创建安全骨架；仍需补齐 Contract、失败语义、测试、Composition Root 注册和文档。
