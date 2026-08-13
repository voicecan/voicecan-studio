# 新增 Processor

输入：ASR 或 Summary、执行位置、官方协议、模型/Prompt 版本、超时和最大响应。先运行 `npm run generate:processor -- --name <id> --kind asr|summary`。

1. 不修改 Domain，先实现现有 `TranscriptionProcessor` 或 `SummaryProcessor` Port。
2. External 实现放 Infrastructure，验证 URL、鉴权、超时、响应大小、429/5xx 和 Contract；不要把 Key 放进业务 DTO。
3. Local Full 使用 JSONL 子进程、固定依赖/模型 Revision、Manifest/大小/SHA-256、FIFO、超时/崩溃恢复和最小环境。
4. Summary 输出必须再次执行引用校验；ASR 输出必须保持全文、Segment 和时长一致。
5. 在 Composition Root 显式选择，不增加 `fixture` 生产配置。

参考：`src/shared/processor.ts`、`src/summary-processor.ts`、两个 `local-*-processor.ts`。

测试至少覆盖 ready=false 不创建 Grant、鉴权脱敏、超时、响应损坏、模型篡改和重启。

```bash
npm run verify:change -- --capability recording   # ASR
npm run verify:change -- --capability summary     # Summary
```
