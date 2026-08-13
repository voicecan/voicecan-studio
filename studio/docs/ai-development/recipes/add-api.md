# 新增 API

输入：方法、路径、请求/响应 Contract、权限、幂等/Revision 语义和错误码。

1. 在 Capability 的 Domain/Application 定义 Contract 与 Use Case；在 Manifest 声明 API contributor。
2. 在 `web.ts` 只做 Host/Origin、Operator 认证、Body Limit、JSON 校验、ETag/base revision 和 Use Case 调用。
3. 写操作必须拒绝陈旧 Revision（409）；不可把 SQLite、Processor 或 SDK 调用写进路由。
4. 响应不返回 Secret、临时下载 URL或不必要的完整历史；错误先脱敏。
5. 添加 HTTP Contract 测试：成功、401/403、415/422、409、404、Body Limit 和重放。

参考：`/api/v1/recordings/:id/transcript`、`summary` 和 `deliveries`。

完成条件：Manifest/Catalog 已更新，路由无业务状态机，`npm run verify:change -- --capability <id>` 与相关 HTTP 测试通过。
