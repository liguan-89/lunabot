# 受控屏观看入口：内嵌页面 + 只读悬浮窗

## 为什么

受控虚拟屏（`PhoneUiDisplaySession`）只在 phone job 到达时按需创建、空闲
约 120 秒释放，且渲染到 helper 自己的 display——物理屏和 APP UI 都看不
到它。用户想看 bot 在手机上的实时操作，需要一个明确入口。三个已拍板的
产品决定：

- 形态：**内嵌页面 + 悬浮窗都要**（Mika capsule 的对应物，但只读）；
- 生命周期：**仅任务期间**——session 的创建/释放策略不动，观看方只是
  订阅者，不阻止 120 秒空闲回收；
- 交互：**只读观看**——不把触摸映射进受控屏，不与 bot 的操作竞争。

## 设计

### 帧源（已存在）

`PhoneUiDisplaySession` 的 ImageReader 持续保留最新帧，`capture()`
返回一份 Bitmap 拷贝——纯读，观看方轮询它不会影响执行器。

### `PhoneUiMirror`（新增，phoneui 包）

进程内单例，把"当前活跃的 session"发布为 `StateFlow`。
`PhoneUiTaskExecutor` 在 `acquireSession` 创建时 `attach`，在两处关闭
路径（`acquireSession` 的过期关闭、`release()`）`detach`——detach 用
CAS，避免新 session 顶掉旧 session 后被误清。观看方只依赖 mirror +
`PhoneUiShellBridge.shell`（helper 断开时视为无画面），不反向引用执行器。

### 内嵌观看页（ui 包）

Settings「手机界面」区块新增一行「观看受控屏」，打开一个
`SettingsSheet`：有 session 时用 AndroidView + ImageView 轮询
`capture()`（约 3fps，换帧后回收上一张 Bitmap），无 session 时显示
占位文案。页面出现与否不改变 session 生命周期。

### 悬浮窗（phoneui 包）

`PhoneUiScreenOverlay`：`combine(mirror.display, bridge.shell, pref)` +
`Settings.canDrawOverlays` 全真时，用 WindowManager 挂一个小尺寸
`TYPE_APPLICATION_OVERLAY` ImageView（屏幕右下角，约 1/3 屏宽，按受控
屏宽高比）；`FLAG_NOT_TOUCHABLE|NOT_FOCUSABLE|NOT_TOUCH_MODAL`，触摸
穿透、不可聚焦——纯展示，零交互。同一 `capture()` 轮询把帧写进
ImageView，旧 Bitmap 在换帧后回收。helper 断开、session 关闭或权限被
撤销（轮询中复查）都会摘掉窗口。不需要 Service：任务运行时本进程必然
存活（job 由它执行）。

### 开关与权限

`ChatPreferences` 新增 `phoneUiOverlay`（默认关）。Settings 开关行：
开启时若无悬浮窗权限，跳 `ACTION_MANAGE_OVERLAY_PERMISSION`，返回后
已授权才写入 true；权限被撤销时开关回退为关。Manifest 增加
`SYSTEM_ALERT_WINDOW`（带注释：opt-in，只在开开关时经系统页面授予）。

### 装配

`OpenMausApp.onCreate` 在 `phoneUi`/`phoneJobs` 之后构建
`PhoneUiScreenOverlay(this, appScope, chatPreferences.phoneUiOverlay)`。

## 明确不做

- 触摸映射/接管（只读）；
- 观看时保活 session（120 秒空闲策略不变）；
- 常驻手动开关虚拟屏；
- 悬浮窗拖拽/缩放/点击展开（`NOT_TOUCHABLE`）；
- 把帧流推到桌面端（带宽与隐私是另一回事）。

## 验证

- `./gradlew :app:compileDebugKotlin`（或项目现有编译任务）；
- 与 phoneui 包相关的单测；
- 真机手测留给设备环节：开任务 → 观看页出画面 → 120s 后消失。
