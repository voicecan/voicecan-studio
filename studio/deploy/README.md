# Local Full 网络边界

`network-policy.yaml` 是 Local Full 的默认拒绝策略，只允许受信 Ingress、集群 DNS 和到真实 Device Platform 的流量；它不允许公网模型、HTTP ASR/Summary、对象存储或通用互联网出口。

`network-policy.courier-egress.yaml` 是管理员显式启用 Courier 后才应用的附加策略。按环境把目标限制到 Courier 所需的受控出口；不要添加无审计的通用 `0.0.0.0/0` 放行。

部署时请记录已应用策略及 CNI 版本；启用通知时，同时记录受控出口和 Courier Workspace 配置。Local Full 的默认网络策略支持本地处理和 Device Platform 访问，Courier 出口需要显式启用附加策略。
