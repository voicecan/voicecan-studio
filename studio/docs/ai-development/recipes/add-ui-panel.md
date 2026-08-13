# 新增 UI Panel

输入：所属 Capability、操作目标、状态、窄屏行为和所需 API。

1. 在 Manifest 声明 UI contributor；复用 `studio-page.ts` 的 Industrial token、字体、间距和内联 SVG 图标。
2. 显式设计 loading、empty、failed、stale、conflict、disabled 和 success 状态；状态不能只靠颜色。
3. 写操作使用 Operator Token、expected revision 和页面内表单；不要依赖 `prompt()`，不要把 Token 放 localStorage。
4. 轮询期间保留音频播放、编辑内容和焦点；Segment 控件支持键盘和可见焦点。
5. 用真实浏览器验证主路径、控制台、键盘焦点及 390px 窄屏无横向溢出。

参考：Recording 列表、Transcript Stage、stale Barrier 和 Delivery History。

完成条件：API 失败可恢复、无 console warning/error、桌面/窄屏通过，相关 HTTP/领域测试全绿。
