# 隧道僵尸流与流控失效修复

## 问题

真机巡检发现隧道周期性退化：19 点健康 → 20 点退化 → 20:45 自愈 → 21 点又退化。
退化期一切 RPC（消息/PATCH/上传）卡 20-90 秒，直连局域网 18ms 健康的同时隧道内
请求卡死——问题在隧道内层，不在网络。

## 根因（源码实证）

### Bug 1：孤儿 SSE 流泄漏

```
Android SSE 重连/取消
  → E2eStreamSocket.close() 只发 finish()（FIN）       E2eTransport.kt:198
  → 电脑端 stream.pipe(socket, { end: false })          session.ts:429
  → FIN 到不了 HTTP 层
  → req.on("close", client.close) 永不触发              server/index.ts:15264
  → SSE client 永远留在 sseClients
  → screens=on 时屏幕帧持续发给僵尸流
```

每次 SSE 重连留一个僵尸流，屏幕帧流量随时间线性累积，直到隧道被堵死、
ping 超时、session 判死重连清零——这就是"周期性退化"的完整循环。

注意：`E2eHttp.request` 的半关闭语义（写完请求 finish 后读响应）必须保留，
`halfclose-reply.test.ts` 固化了这个行为。不能简单把 finish 全改 reset。

### Bug 2：接收窗口入队即归还，流控失效

`E2eSession.kt:280-284`：`deliver()` 把字节塞进 `LinkedBlockingQueue` 后立刻
`consumed()` 归还 yamux 窗口。OkHttp 还没读，电脑端就看到窗口恢复继续发，
字节在手机进程内无界排队。per-stream flow control 形同虚设。

### Bug 3：后台屏幕流量不停止

- `ComputerPolicy.kt:92-101`：后台不清 screens watcher，重连后仍 `screens=on`（注释自认泄漏风险）
- `ThisComputerViewer.kt`：viewer 用 appScope 轮询截图（只读 5s/接管 1.5s），
  dispose 才停，退后台通常不 dispose

## 修复方案

### 修复 1：关闭路径区分"正常结束"与"废弃"

- `E2eStreamSocket`：output stream 的 `close()` 保持 finish（HTTP 请求体半关闭语义）；
  socket 整体 `close()`（连接池废弃/取消）改发 `reset()`。
- 依据：HTTP 语义里 output.close 是"请求体写完"；socket.close 是"这条连接不要了"——
  后者对永不结束的 SSE 响应就是废弃信号，reset 让电脑端立刻 destroy MuxStream，
  origin socket 随之 close，`req.on("close")` 触发，SSE client 被清理。

### 修复 2：接收窗口延迟归还

- `E2eStream.deliver()` 不再立即 `consumed()`；`read()` 真正消费字节后才归还。
-  inbound 队列加容量上限（如 2 MiB = 一个 stream window），超限 reset 该流，
  防止内存无界增长。

### 修复 3：后台停止屏幕流量

- `ThisComputerViewer` 轮询循环检测 app 前台状态，后台暂停轮询。
- SSE screens watcher 维持现状（重连后恢复是设计意图，且修复 1 后僵尸流不再累积）。

## 验证

- T0：`:core:test` 中 e2e 相关测试（E2eSessionTest/YamuxVectorsTest/OkHttpE2eConnectorTest）
- T1：core 全模块测试 + compileReleaseKotlin
- 真机：装机后长时间观察 logcat `OMB-E2E` 时间线，确认重连后无流累积
