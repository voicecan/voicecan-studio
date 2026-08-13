# 新增 Scenario Pack

1. 运行 `npm run generate:scenario -- --name <id> --title <title>`。
2. 在 Manifest 声明字段、默认 attribute、Processor Stages 和允许的 Action；版本必须明确。
3. `build()` 只能根据已验证的 Recording snapshot、Transcript 和 Summary 做纯 Projection。
4. 所有 `segment_refs` 必须存在；Result 必须绑定输入的 Transcript/Summary Revision。
5. 测试默认选择、手动切换、字段校验、stale、审核失效和“切换不重转写”。
6. 更新 `EXTENSION-CATALOG.md`，运行 `npm run check:architecture && npm test`。

不要在 Scenario 中调用网络、数据库、文件系统、模型或第三方 SDK。
