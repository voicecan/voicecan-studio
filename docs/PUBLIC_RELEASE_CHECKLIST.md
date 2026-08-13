# 公开发布检查表

本文档以“从当前工作树创建全新公开仓库、重新初始化 Git 历史”为前提。不要复制现有父仓库的 `.git`、运行数据或构建输出。

## 当前阻塞项

- [ ] 确认 `SECURITY.md` 所述私密报告渠道在目标托管平台可用，并补充组织的直接安全联系方式。
- [ ] 确认公开仓库 URL、Issue Tracker、维护者和发布镜像地址，再补入 README/package metadata。

## 初始化新仓库

1. 从当前工作树复制源码；排除 `.git/`、`node_modules/`、`dist/`、`.env`、`data/`、`work/`、`models/`、数据库、日志、音频和模型文件。
2. 重新运行 `git init`，检查 `git status --ignored`，只提交预期源码与固定依赖制品。
3. 运行 `npm ci --ignore-scripts`、`npm run ci` 和两种 Docker 构建。
4. 运行 `npm run check:public-release`；该命令必须在补齐许可证后通过。
5. 运行 `npm audit --omit=dev --audit-level=high`；记录审计日期和结果。
6. 审核首次提交的完整 diff，确认没有旧应用名称、过时脚本、私有仓库路径、真实域名凭证或内部基础设施信息。

## 安全与供应链

- [ ] 保护默认分支，要求 CI、代码审查和线性合并策略。
- [ ] 为 CI Action 固定可信版本或 commit SHA，并确认目标 Gitea Runner 的兼容性。
- [ ] 启用依赖更新、Secret scanning、代码扫描和私密漏洞报告能力；目标平台缺少能力时记录替代方案。
- [ ] 发布 SDK/模型/二进制时同时提供来源、不可变版本、SHA-256 和许可证。
- [ ] 将生产 Secret 放入托管平台 Secret Store；任何 Secret 泄露都按已经泄露处理并立即轮换。
- [ ] 公网部署使用带认证的 TLS Ingress，不直接暴露默认回环监听服务。

## 文档与社区

- [ ] README 快速开始在一个全新 Linux/Windows 环境实测通过。
- [ ] External、Local Full、Docker、零外联模式和 Courier 可选出口均有验收记录。
- [ ] `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`SUPPORT.md` 与实际维护流程一致。
- [ ] 发布版本、变更记录、支持范围和弃用策略已确定。
- [ ] 用真实 Device Platform 测试账号验证 Recording → Processor → Artifact → Scenario → Review → Action → Courier 状态回写全链路，不提交测试数据。
