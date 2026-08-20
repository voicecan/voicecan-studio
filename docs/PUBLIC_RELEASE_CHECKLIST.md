# 公开仓库维护与发布检查表

本文档用于维护 Voicecan Studio 的公开仓库和发布版本。每次发布前完成与本次变更相关的检查，并在发布记录中保存结果。

## 仓库与发布信息

- [ ] 公开仓库 URL、Issue Tracker、维护者和发布镜像地址已与 README 和 package metadata 一致。
- [ ] 默认分支启用 CI、代码审查和线性合并策略。
- [ ] 版本、变更记录、支持范围和弃用策略已更新。
- [ ] 发布内容不包含 `.env`、运行数据、数据库、日志、音频、模型文件或内部路径。

## 构建与运行

- [ ] 在全新的 Linux 环境运行 `npm ci --ignore-scripts`、`npm run build` 和 `npm run ci`。
- [ ] External、Local Full 和两种 Docker 配置均可启动。
- [ ] Setup 页面可以保存配置，重启后服务可以恢复运行。
- [ ] Recording → Processor → Artifact → Scenario → Review → Action 流程可完成，且不提交真实用户数据。
- [ ] Local Full 可以在关闭通知出口时完成审核、预览和 Markdown 导出。
- [ ] Courier 启用时，Action Preview、幂等提交和状态回写行为已检查。

## 安全与供应链

- [ ] `SECURITY.md` 中的私密报告渠道在目标托管平台可用。
- [ ] CI Action、模型、SDK 和二进制依赖使用可信版本或不可变来源。
- [ ] 运行 `npm audit --omit=dev --audit-level=high` 并记录结果。
- [ ] 公开发布的 SDK、模型和二进制制品包含来源、版本、SHA-256 和许可证信息。
- [ ] 生产 Secret 使用托管平台 Secret Store，并已完成轮换计划。
- [ ] 公网部署使用带认证的 TLS Ingress，不直接暴露默认回环服务。

## 文档与社区

- [ ] README 和运行手册中的命令、端口、配置名和链接与当前版本一致。
- [ ] 中文 README 与英文 README 的产品能力和快速开始保持一致。
- [ ] `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md` 和 `SUPPORT.md` 与实际维护流程一致。
- [ ] `THIRD_PARTY_NOTICES.md` 和许可证文件已更新。
- [ ] 发布说明包含用户可见变化、升级提示和已知操作影响。
