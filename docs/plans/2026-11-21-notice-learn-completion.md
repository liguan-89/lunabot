# Notice learning: tiers that mean something, shade hygiene, a real switch

## Why

The notice pipeline landed wired end to end but three audit findings keep it
half-done, all small and independent:

1. **`balanced` is dead.** `LEARN_LEVELS` is
   `conservative:[] / balanced:["high"] / aggressive:["mid","high"]` and every
   app's `SourceTier` is hardcoded `"mid"` — so balanced never surfaces a
   topic into tasks, collapsing three levels into two.
2. **`retainKeys` has no caller.** A notice the person dismisses on the phone
   stays in `NoticeInbox` — and `PHONE_NOTIF_LIST` — until it ages out, and a
   server restart has no way to re-converge on what's actually on the shade.
3. **`noticeLearn` has no UI.** A pipeline that reads notification contents
   is gated by a hand-edited `config.json` enum, so the consent surface is
   effectively invisible (the Android per-app tick list governs the *uplink*
   only — it cannot switch the server-side learner).

## Phase A — tier by content, not by nothing

The wire already carries the signal: `NoticeRelay` sets `conversation: true`
exactly when a `MessagingStyle` was extracted, and `messages` holds the
parsed lines. An app that produces conversation notifications is the
high-trust source the level table was designed for.

- `noticeSinkFor` keeps a `msgApps: Set<string>` per owner; `noticeFor` marks
  a package when an admitted record has `conversation === true` or a
  non-empty `messages`.
- `learnedNotices` / the tier callback becomes
  `(pkg) => sink.msgApps.has(pkg) ? "high" : "mid"`.
- The set is session memory only — it self-heals on the next chat notice and
  needs no file. Unticking an app removes it.
- Semantics after the change: `conservative` still never surfaces;
  `balanced` surfaces topics learned from conversation sources after
  `topicDays`; `aggressive` surfaces any source. No table change, no UI.

## Phase B — the shade is the reconciler

One new wire event carries the full active-shade key set for ticked apps;
`NoticeInbox.retainKeys` is exactly the consumer that was left unwired. One
shape covers both trigger moments:

```ts
{ kind: "notice-shade", keys: string[] }   // active sbn keys, ticked packages only
```

- Android `NoticeRelay` posts it after `onListenerConnected` (covers service
  restart and server restart) and after `onNotificationRemoved` (covers
  dismissal). Sending remaining keys — not the removed one — makes both paths
  idempotent and side-effect-free under reordering.
- Keys are filtered to ticked packages before posting, so no unticked
  package name crosses the wire; when the share switch is off nothing is
  sent (the existing noticeApps-prune on re-register already purges).
- `routes/phones.ts` gates it on `phoneData` alongside `kind === "notice"`;
  `host/phones.ts` routes it to `retainKeys(new Set(keys))`.
- LearnBuffer entries are not key-pruned — they age out on their own.

Deliberately not: a per-removal event (the snapshot subsumes it), persisting
inbox/dedup/buffer state (the snapshot *is* the persistence story — the phone
re-tells the shade on every reconnect), and dismiss/open *tracking* for
learning, which stays excluded by design.

## Phase C — the level gets a Settings row

`features.noticeLearn` is already a four-value enum. Add one row in the
phone settings section (same surface the verify flag uses): a select of
off / conservative / balanced / aggressive with one line of honest copy per
level. English and 简体中文 strings land now; the other catalogs fall back to
English per the locale rules, and `pnpm i18n:check` gates it.

## Deferred on purpose

- `PHONE_REPLY_WECHAT` image replies: wire gain + Android executor hook, but
  it touches the same dispatch surface as the `phoneData` PR — scheduled
  right after that merges.
- `phone-risk.ts` stays dead code: its five-grade table is the base of any
  risk-tiered approval policy, which is a trust-model decision, not a chore.
