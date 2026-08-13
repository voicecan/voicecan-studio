# 集成第三方 SDK

输入：厂商、官方 SDK、许可、精确版本、所需操作、Secret、网络出口和幂等语义。先运行 `npm run generate:integration -- --name <id> --sdk <official-package>`。

1. 先确认官方 SDK 能覆盖需求；固定精确版本和 lockfile，不用裸 HTTP 补实现。
2. 在 `ports/` 定义厂商无关接口和 Contract Test；SDK 类型只在 `infrastructure/` 出现。
3. Secret 使用环境变量或 `0600` 配置，只写不回显；日志/错误必须脱敏。
4. 映射超时、429、5xx、永久 4xx、request ID、状态和 History；明确接受前/接受后的重试责任。
5. 添加 SDK Stub 测试，不模拟厂商下游协议。涉及真实提交时使用 Test Workspace 并记录证据。

Courier 参考：`NotificationProvider` 与 `CourierNotificationProvider`。渠道路由、模板、偏好、重试和日志属于 Courier；不要新增 Slack/Teams/Email Transport。Device Platform SDK 只能出现在 `src/platform/`。

```bash
npm run verify:change -- --capability delivery
npm run check:boundaries
```

完成条件：官方 SDK typed API、精确版本、错误映射、幂等、Secret/网络说明和 Contract Test 全部具备。
