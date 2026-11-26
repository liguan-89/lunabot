# PHONE_UI_TYPE 非 ASCII 输入：剪贴板粘贴回退

日期：2026-11-27
状态：实现中

## 背景

`PHONE_UI_TYPE` 在输入框不支持 `ACTION_SET_TEXT` 时（WebView、自研编辑器）
退回 key events，但 key events 只能写英文/数字；非 ASCII 文本直接失败：
「手机端还没有输入法接管」。对中文产品这是核心缺口——微信、网页表单里的
中文输入全部不可用。

## 方案：剪贴板粘贴

Android 无障碍节点支持 `ACTION_PASTE`（API 18+）：把文本写入系统剪贴板，
聚焦输入框后执行 paste action。系统完成粘贴，目标应用作为前台读剪贴板完全
合法，全 Unicode 支持，不需要 IME。

输入路径优先级：

1. `ACTION_SET_TEXT`（现状，最优——原子替换、无剪贴板副作用）
2. **新增**：节点支持 `ACTION_PASTE` → 剪贴板粘贴（全 Unicode）
3. ASCII 且不支持 paste → key events（现状—— paced 拟人输入保留给这个通道）
4. 非 ASCII 且 paste/set-text 都不支持 → 拒绝，文案更新

关键决策：

- **粘贴是一次性写入**，不做 paced 分段——`TypingPace.forField` 的
  paste-only 规则本就说明 web 字段不分段（"the app would not receive the
  earlier writes"）。粘贴通道天然符合。
- **剪贴板残留**：粘贴后剪贴板保留文本。Android 10+ 非前台应用读不到剪贴板，
  无障碍服务也读不到，无法可靠恢复旧内容；敏感字段（密码）本就被拒绝输入。
  与既有 `PHONE_CLIPBOARD_SET` 工具语义一致。
- Android 13+ 写剪贴板有系统 toast 提示——可接受的 UX 噪音，换来中文输入能力。

## 验收

- `:app:testDebugUnitTest` 绿（新增粘贴通道路径测试）
- `:app:compileDebugKotlin` 绿
- 模拟器验证：WebView 输入框输入中文成功
