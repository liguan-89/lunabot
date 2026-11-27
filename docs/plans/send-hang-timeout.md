# 发送悬挂：socket close 无法中断本地阻塞 I/O

2026-11-27。状态：设计已确认，实施中。

## 问题

隧道退化期发消息，UI 永远停在"正在发送…"（输入框占位符），既无失败提示
也无出路；重启 app 后依然。理论上 `actionClient` 有 30 秒
call/read/writeTimeout，实测悬挂 5 分钟+毫无动静。

## 根因链（逐环有代码证据）

1. OkHttp/okio 的 readTimeout 与 callTimeout 到期后的动作都是
   **close socket**（okio `SocketAsyncTimeout.timedOut()`、call cancel 的
   connection close）——靠真实 socket "close 会中断所有阻塞 read/write"
   的语义来中断 I/O。OkHttp 不用 `Socket.soTimeout` 实现 read 超时，
   所以 `E2eStreamSocket.timeoutMs` 始终为 0，`E2eStream.read` 走
   `inbound.take()`——**无超时永久阻塞**的那条路径。
2. `E2eStreamSocket.close()` 只 `stream.reset()`——向**远端**发 RST 帧，
   对**本地**阻塞者毫无作用：
   - reader 停在 `inbound.take()`，队列无人投递，永睡；
   - writer 循环 `stateLock.wait(1_000)` 靠 `reset` 字段退出，而本地
     `reset()` 路径从不设置该字段（只有远端 RST 到达的 `remoteReset()`
     会），writer 无限等窗口。
3. 于是超时到期 → close 被调用 → 本地 I/O 线程不醒 → OkHttp 回调永不
   触发 → `performUnchecked` 的 `suspendCancellableCoroutine` 永不
   resume → `Session.send` 协程永不返回 → `sendingMessage` 靠
   `finally` 复位永远执行不到 → 输入框永远"正在发送…"。

UI 层本身健全（失败后恢复草稿+错误提示），不需要改；病根在传输层。

## 修复

`E2eStreamSocket.close()` 在发远端 RST 之后，唤醒本地阻塞的
reader/writer：`E2eStream` 新增内部 `interruptBlocking()`——置 `reset`
标志、`stateLock.notifyAll()`、向 `inbound` 投递空数组。效果：

- reader：`take()` 返回空数组 → 检查到 `reset` → read 返回 -1（EOF），
  OkHttp/okio 把它归因为 close/timeout，回调正常触发；
- writer：notifyAll 即时唤醒（替代最多 1 秒的轮询延迟），检查到
  `reset` → write 返回 false → socket 层抛 `IOException`。

对正常路径无害：池驱逐空闲连接、SSE 主动重连的 close 都没有阻塞者，
interrupt 是空操作；SSE 被 cancel 后 read 返回 -1，正是重连逻辑期望的
EOF 语义。

## 显式不做

- 不缩短 30 秒超时值：超时存在的意义是兜底，真正让"30 秒太久"消失的是
  隧道不再退化（tunnel-zombie-streams 三修复 + 后续桥接短命调查）。
- 不改 UI 层：失败恢复草稿、错误提示、`finally` 复位都是对的。
- 不给 write 加自超时：等窗口是流控的正常行为（大上传合法地需要），
  正确的中断源就是 close/cancel。

## 验证

- 回归测试：`E2eSessionTest` 全同步内存管道——read 阻塞中 close socket
  侧（stream interrupt）后 read 返回 -1；write 阻塞在零窗口时 interrupt
  后 write 返回 false。
- 真机：隧道退化场景复现不易，以"30 秒内必然出失败提示"为验收——退化
  期发消息，不再出现无限"正在发送…"。
