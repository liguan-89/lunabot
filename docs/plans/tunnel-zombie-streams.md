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

## 追加（2026-11-27 晚）：companion 侧僵尸不死的断点

真机实证：harness:8799 上 23 条 companion 代理连接常驻，多条呈 SSE 心跳
特征（+84B/20s），累计字节推算存活 4-5 小时；force-stop 手机 app 后
WebSocket 断开确认，僵尸零死亡——清理链断在 companion 内部。

断点（origin.ts）：`duplexPair` 不向对端传播 destroy（代码注释自认），
而防护只做了单向——`serverSide.on("close")` 时 destroy `near`。反向缺失：
yamux 流死亡 → `stream.on("close")` 只 destroy `near` → `serverSide` 永远
感知不到 → 内存 http.Server 认为连接活着 → proxy 的 `res.on("close")`
不触发 → harness TCP 不 destroy → 8799 SSE 僵尸永存。SSE 是唯一没有
超时兜底的交易类型（响应永不完成，keepAliveTimeout/requestTimeout 均不
适用），故僵尸全部是 SSE，只增不减——"周期性退化"的底层发动机。

修复：`near.on("close")` 对称传播 `serverSide.destroy()`。near 是内存
管道，serverSide 存在的唯一目的是服务它；near 一死，serverSide 没有任何
存活理由。重复 destroy 幂等，无循环风险。

## 追加二（2026-11-27 深夜）：force-stop 不触发会话关闭的更底层断点

`origin` 修复后真机对照仍失败，进一步定位发现第一环根本没启动：手机被
`force-stop` 时不会发送 WebSocket close frame，只是内核关闭 TCP。Node 的
HTTP upgrade socket 是 `allowHalfOpen=true`，此时服务器只收到 readable
`end`，不会自动收到 `close`；而 `ws-server.ts` 原来只监听 `close/error`，
所以 `transportClosed()` 从未调用，`E2ESession.#end()`、`Mux.closeAll()`、
流销毁、`origin` 清理全都没有开始。

完整断链因此是两段，缺一不可：

```
force-stop / 进程死亡
  → TCP FIN，无 WebSocket close frame
  → HTTP upgrade socket 只发 end，不发 close
  → ws-server 不调用 transportClosed          ← 断点 1（本次修复）
  → 即使 transportClosed 调用，near 关闭也不传给 serverSide
                                                 ← 断点 2（origin 已修）
  → proxy/harness 永不感知，SSE 僵尸永存
```

修复：`ws-server` 将 `end` 视作传输死亡，`finish(1006)` 销毁本端 socket 并
调用 `transportClosed()`。WebSocket 协议没有半关闭语义，TCP 读端已经结束
后继续假装会话存活没有意义。

测试与真机证据：

- `companion/test/e2e/ws-server.test.ts`：裸 TCP 断开、无 close frame；
  修复前超时无 close 回调，修复后立刻收到 1006。
- `companion/test/e2e`：201 passed / 1 skipped；typecheck 与 oxlint 绿。
- 真机对照（直连路径）：手机连接时 companion→harness 有 50315/50370 两条
  8799 连接；杀掉自动化 helper 防止误复活后 `force-stop`，5 秒后这些确切
  老端口全部消失，8810 无 CLOSE_WAIT 残留。

注意一个测试污染：T3/agent-device 的 `phoneui-helper` 会在 force-stop 后
重新拉起手机 App。观察 Zombie 必须先杀掉该 helper，或以确切本地端口追踪
老连接，不能把新会话的新连接误判为僵尸。
