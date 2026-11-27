# Android 完整 App 页面渲染（issue #128）

## 目标

让 Android 对 `kind=app` 消息挂载真实沙箱页面，而不是只画 fallback 摘要。范围按 2026-11-27 issue 决策：沿用 2026-10-14 原设计的安全模型，实现完整 bridge——`ui/message`、MCP RPC、`ui/update-model-context`、`ui/open-link`、尺寸回传全对齐桌面；RPC 的审批与工具选择边界继续只在 server 侧。

## 安全边界

- 每个 live row 一个 `WebView`；宿主页只从 `WebViewAssetLoader` 的 `https://appassets.androidplatform.net/app/app-host.html` 加载。
- `WebViewCompat.addWebMessageListener` 只暴露给宿主 origin；native 再检查 `isMainFrame` 与 `sourceOrigin`。不支持 `WEB_MESSAGE_LISTENER` 的 System WebView 不降级成不安全 bridge，只显示 fallback 与「更新 Android System WebView」。
- `shouldOverrideUrlLoading` 永远拦截；JS dialog、多窗口、权限请求全部拒绝；文件/content access 关闭；第三方 cookie 关闭。
- 网络层按 `AppDocument.network` 在 CSP 之下再拦一次：宿主 asset、`data:`/`blob:`/`about:`、以及声明的 http(s)/ws(s) 源才放行，其余 403。WebSocket 不由 Android interception 覆盖，仍由 iframe CSP 约束。
- app frame 是宿主页里的 `sandbox="allow-scripts allow-forms"` opaque-origin iframe；phone 不把 bearer token、session 或 client 对象暴露进页面。bridge 的每个动作都由 native 重新走 authenticated `CompanionClient`。

## 实现切片

1. core wire：`AppCardData` 补齐当前 `shared/app.ts` 字段，`Message.fromApp` 解码；新增 `AppDocument`/`AppCan`/`AppNetwork`/MCP tool 形状。
2. core client：`appDocument`、`appRpc`、`appContext`、`sendAppMessage`；RPC 失败保留服务端 `{error,signIn,blocked}` 形状，供 native 回给 View。
3. `Session` 增加同等窄封装，像 widget 一样让卡片拿到服务端拒绝原文；未连接/401 走现有 session 状态折叠。
4. `ChatAppWebView`：WebView 宿主、asset loader、WebMessageListener、native ↔ host-page JSON 协议、engagement 触摸记录、尺寸/初始化/teardown 回调、RPC/message/open-link/context 分发。
5. `ChatAppView`/`ChatAppPool`：单 live WebView（手机）按需挂载，row 离开或 teardown 后收起到占位；高度按 `(messageId, rev)` 记忆；blocked/offline/sign-in strip 与信息行。
6. `MessageRow` dispatch 改为真实 App 卡片；user bubble 增加「发送自 <title>」标注。
7. 资产：`shared/app-frame/app-host.html` 复制到 `android/app/src/main/assets/app/app-host.html`，测试钉住 hash，防止两边漂移。

## 验证

- core：fixture 解码（HTML/MCP/blocked/future/malformed/fromApp）+ MockWebServer 请求形状与错误透传。
- app unit/Robolectric：网络匹配规则、宿主消息解析、URI 拒绝、卡片组装；`androidx.webkit` feature gate 的单测以可注入 predicate 覆盖。
- instrumented WebView 测试按原设计覆盖规则 1/4/5/6/7/9/10/12；若本机无可用的最老 System WebView 镜像，至少在现有模拟器实测 `WEB_MESSAGE_LISTENER`，并在 PR 明示最老镜像未实测。
- T0/T1：`:core:test` 定向、`:app:testDebugUnitTest` 定向、`:app:compileDebugKotlin`、`pnpm typecheck` 不跑全量；合并前按 T2。

## 非目标

- 不做桌面后来加上的页面管理面（publish/save/pin/point/page pane）；本次只完成 issue 决策列明的渲染与 bridge。
- 不改变 server/companion 路由与审批语义；房间仍由 server 下发 view-only `can`，Android 不自行放宽。
- 不为不支持 WebMessageListener 的 WebView 发明降级 bridge。
