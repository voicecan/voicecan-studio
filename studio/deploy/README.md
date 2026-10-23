# Local Full network boundaries

[简体中文](README.zh-CN.md)

`network-policy.yaml` is the default-deny policy for Local Full. It allows only trusted ingress, cluster DNS, and traffic to the actual Device Platform. It does not allow public model services, HTTP ASR/Summary services, object storage, or general internet egress.

`network-policy.courier-egress.yaml` is an additional policy to apply only after an administrator explicitly enables Courier. Restrict its destinations to the controlled egress required by Courier in your environment. Do not add unrestricted, unaudited `0.0.0.0/0` access.

Record the applied policies and CNI version when deploying. When enabling notifications, also record the controlled egress and Courier workspace configuration. The default Local Full policy supports local processing and Device Platform access; Courier egress requires explicitly enabling the additional policy.
