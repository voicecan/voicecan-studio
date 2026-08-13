# 新增 Capability

输入：用户故事、数据所有者、允许依赖、权限和失败语义。

1. 运行 `npm run generate:capability -- --name <id>`。
2. 在 `domain/` 写纯 Contract/不变量，在 `ports/` 写最小接口，在 `application/` 编排 Use Case。
3. 只有 `infrastructure/` 可访问 SQLite、文件、子进程或 SDK；`presentation/` 只声明 API/UI contributor。
4. 在 `manifest.ts` 声明依赖、配置、权限、健康、API/UI 和 Migration；在 `capabilities/index.ts` 注册。
5. 完善局部 `AGENTS.md`，添加 Domain/Port 单元测试和失败测试，重新生成 Catalog。

参考：`capabilities/scenario/` 看纯业务边界，`summary/` 看 Processor，`delivery/` 看第三方 SDK 边界。

```bash
npm run catalog:capabilities
npm run verify:change -- --capability <id>
```

完成条件：无循环/缺失依赖，架构检查通过，Manifest 是唯一注册入口，Capability 不直接 import 其他模块的 Infrastructure。
