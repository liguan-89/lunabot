# WeChat image replies: wire the ported outbound half

## Why

`WechatRuntime.replyImage` is ported, tested, and unreachable: the
`PHONE_REPLY_WECHAT` job shape is frozen at `{ to, text }`, so a bot that
attaches an image to its reply has that attachment silently dropped for
WeChat peers. This is the deferred piece from
`2026-11-21-notice-learn-completion.md`, scheduled after the phoneData
dispatch landed on the same surface — it stacks on `feat/notice-learn-v1`.

## Where the image comes from

A bot sends a file or image through the attach path
(`server/bot-attachment.ts`): `saveBotAttachment` copies it into the private
store and the reply message carries
`attachments: [{ kind: "image", path, mime, name, source }]`. `path` is a
file inside `ATTACHMENTS_DIR`, so the relay can read the bytes back. Images a
tool's *result* returned are marked `fromTool` — the bot saw them, it did not
send them — and never qualify.

## Change

- `server/wechat-relay.ts` `turn.completed` loop: keep one reply job per bot
  text as today; additionally, for each `kind === "image"` attachment with
  `!fromTool` on that turn's bot messages, read the saved file and send one
  job per image (Mika's rule: one image per outbound message). A read or
  size failure warns and skips that image only.
- Job args grow an optional field: `{ to, text, image?: { mime, data } }`
  with `data` base64. `replyWechat(phoneKey, to, text, image?)` passes it
  through `jobs.request` unchanged.
- `answerWechatReply`: when `image` is present, base64-decode `data` and call
  `runtime.replyImage(clientId = job.id, to, bytes)`; decode failure or empty
  bytes is `invalid`. Absent `image` keeps the exact `reply(to, text)` path.

Deliberately not: file/video/audio attachments over WeChat (iLink's outbound
port here is images only, same as Mika), captions (`sendImage` takes none),
batching several images into one job, and any SMS-side image reply (the SMS
relay has no outbound media path at all).
