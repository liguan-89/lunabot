# Phone brain wiring: wake the three dormant Mika ports

## Why

The Mika port batch landed the pure cores and left three of them unwired on
purpose (`docs/mika-gap-analysis.md`): route replay, the intent gate and
notification learning. `matchRoutes` is already on the phones object with a
comment saying nothing injects it "before any replay exists to run it". This
plan turns the recording into a working feature in three phases, smallest
first. None of them moves the brain onto the phone: the turn still runs
server-side; the phone stays the executor.

## Phase 1 — route replay via PHONE_UI_RUN (this batch)

A stored `Route` is already replayable through `PHONE_UI_RUN`: each
`RouteStep` carries a `Selector` (role, name, resource id, bounds, ordinal)
and `before`/`after` `Anchors` (package + stable texts), and a run command
re-finds its target on the current screen exactly the way the executor
already resolves selectors. The model is the slot-filler (`routeSlots` /
`templateValues` stay the correctness reference in tests, but the prompt just
hands the template over). No new phone tool, no new executor.

Wiring:

- `promptParts` in `server/host/phones.ts` computes the turn's goal the same
  way `turnEnded` does (`deps.request(threadId)` → the person's line).
- `host.parts` gains a third `PromptPart` `device-route`, built by
  `routes.match(owner, goal)`:
  - inject only when `needsDecision(candidates)` is false (one confident
    match); an ambiguous shortlist stays out — the alternative is a decider
    call before the turn, which spends the saving this feature exists for;
  - text: the template plus one line per step (`tool`, selector hints) and a
    rule sentence: re-run it with `PHONE_UI_RUN`, assert the first step's
    `before` anchors first, refs are fresh, a step that does not match means
    the route does not apply.
- Disabled routes and routes with `consecutiveMisses` past a bound are
  already filtered by `match`/`routeCandidates`; nothing new there.

Deliberately not in this batch: a dedicated replay job the phone could run
while the server is unreachable (a real on-device executor — separate work).

## Phase 1b — replay bookkeeping (this batch)

Mika settles a replay against the route immediately (`RouteReplay.update`):
a divergence counts a miss at the step it died on — two misses at the same
step retire the route (`ROUTE_MISSES_TO_DISABLE = 2`), one elsewhere only
counts — and a completed replay is credited `successes + 1` only when the
whole task ends `done` (`noteResult` + `LearnGate.done`). Here the model
replays, so the verdict comes from the turn's call ledger instead:

- `promptParts` remembers the route the `device-route` part carried, per
  turn key; `endTurn`/`turnEnded` hand it to `host.endTurn` as
  `offeredRoute`.
- `host.endTurn` settles it against the evidence: only calls that ran
  (`ok`, replayable) count — a refusal, a timeout or a missing phone never
  ran, so a `discuss`-gated turn does not punish the path. Every ran call
  `changed` the screen on an unstopped, unspoiled turn → `success`; the
  first call that changed nothing → `miss` at that index (our `done`); a
  stopped or spoiled turn → `used`, a `lastUsedMs` touch alone.
- `PhoneRoutes.settle` ports the write: `success` clears the miss run;
  `miss` keeps `consecutiveMisses` only when `missStep` repeats, else
  resets to 1, and disables at the bound.

## Phase 2 — intent gate (this batch)

Mika's gate is lazy, once a turn, and fail-open: `AgentLoop` assesses intent
only at two places — before replaying a route, and before the first outside
tool call — and only for a request the person themselves put in the chat.
The port lands the same shape:

- `PhonesDeps.decider` is the decision leg (`botDecide` seam, the same
  relay-taken shape as app-picks); `PhonesDeps.verify` doubles as the judge
  — a plain one-off text call on the bot's engine answering the gate's
  question in one word, exactly Mika's fallback when the decision call
  cannot answer. With neither wired there is no gate, and everything runs
  as before.
- `intentFor(turn)` in `server/host/phones.ts` memoizes one promise per
  `threadId:botId:generation`; `originIsUser` scopes it to the person's own
  turns, `endTurn`/`turnEnded` drop the entry.
- **Route part**: `promptParts` became async. When exactly one route fits
  it awaits the verdict and passes it to `host.parts` — `discuss` or an
  unreadable answer keeps the path out (fail-closed on the hint, as Mika
  keeps replay out); `read`/`act`/no-gate are told it.
- **Call gate**: `run` in `server/phones/host.ts` asks `deps.intent` before
  the loop guard and the outbound card — a `discuss` verdict refuses the
  call (and, through the cached verdict, every later call this turn) with
  Mika's "answer in text, touch nothing outside" notice as the tool result.
  Every other verdict and every failure runs as before (fail-open).

Not ported: Mika's `DISCUSSION_LOOKUP_VERBS` exemption — its memory and
knowledge reads are not phone tools here, so no phone call needs exempting;
and the `conversation_intent` notice row — the refusal's own text carries
the same instruction to the model.

## Phase 3 — notification learning ingress

Shipped. Consent is per-package, never blanket: the phone pushes only
notifications from apps the person ticked in Settings →「分享哪些应用的通知」,
and only while the「分享通知给智能体」switch is on.

Wire: `phoneEvent` grew a `notice` member (`phoneNotice` in
`server/phone-notices.ts`, the `NoticeRecord` fields plus `key`); the
registration declares the whitelist as `noticeApps`. `POST
/api/phones/self/events` switches on `kind`: `sms`/`wechat` ride the
`messages` grant, `notice` stands on `phoneData`. `server/host/phones.ts`
keeps a per-owner `{ NoticeInbox, dedup }` (bounded, evicted at 16 owners);
each event is sanitized, gated by `shouldLearn` against the *registered*
allow-list — a phone lying about its grants lands in no inbox — deduped,
then added. `noticeInbox(ownerKey)` exposes the snapshot; an unticked
package's kept records are pruned on the next event (`removePackages`).

Phone side: `NoticeRelay` still records locally for `PHONE_NOTIF_LIST`; when
sharing is on it builds a `PhoneNoticeEvent` (`NoticeEvent.of`, which already
drops ongoing/foreground-service/non-clearable/group-summary posts and
extracts MessagingStyle lines), dedupes reposts in memory, and posts once
the session is live. `PhoneJobRunner` re-registers when the allow-list
changes, like any other capability. The system listener grant is asked for
from the switch, the same page the SMS relay uses.

## Phase 3b — notification consumer (triage + surface)

Shipped. `server/host/notice-triage.ts` ports Mika's `NoticeTriage.kt` and the
scheduling slice of `TriageRunner.kt`; `server/host/phones.ts` attaches one
runner per owner inbox and pokes it on every accepted notice — event-driven,
no polling.

The judge is a plain text call on the owner's chief bot's engine
(`deps.noticeJudge`, 30 s) — a general chat model as Mika's NoticeTriage
takes, never the decision model. Absent wiring is no triage at all; the
inbox still learns. The batch prompt carries per-app notices oldest-first
with titles, texts, MessagingStyle lines and short per-key history, all
cleaned and defused as data. The reply parser is Mika's: the reply must end
in `{"items":[…]}` or a bare array; unknown ids are dropped, a repeated id
keeps its first verdict, an unreadable or missing verdict is `ignore` with
the built-in `no-verdict` note, and a reply carrying no JSON fails the whole
batch (marks `failed`, consecutive-failure hold) rather than quietly
ignoring everything.

Scheduling reuses `planTriage`: gather a 20 s window or send early at 8
pending, oldest-first per app, one judge call in flight, busy = a job in
flight to any of the owner's phones, budget = a provisional 30 calls per
owner per day, surface cooldown/backoff per key as `cooldownMs` encodes.
Deliberate divergence: `unlocked` is always true — the server cannot see
the phone's lock screen, a surfaced batch lands in a thread that waits for
the person anyway, and the daily call cap bounds spend. Marks, cooldowns
and first-seen clocks are in-memory per owner; keys the bounded inbox
evicts lose their marks.

A `surface` verdict is delivered by `deps.noticeSurfaced`: index.ts routes
it to the chief bot, one thread per `owner|package` (channel-chats map,
like an inbound SMS thread), via `acceptDirectSend` — so a surfaced notice
reads as an inbound event the bot answers in place, never an autonomous
phone action. Threads are created inactive; per-app daily surface cap
(conservative 10) converts overflow verdicts to `ignore`/`surface-capped`.

## Phase 3c — learn pipeline (topics into tasks)

Shipped, opt-in via `config.features.noticeLearn` (`off` default;
`conservative` runs the pipeline but lets nothing into tasks — Mika's
default split between learning and showing).

`server/notice-learn.ts` ports the topic half: `LearnBuffer` (kept notices
become events, the same key+text inside the 12 h repeat window is a
repost, an app is due at 12 pending or its oldest aged 30 min),
`buildLearnInput`/`parseLearnReply` (Mika's strict parse: cite `t1…` or
open `{kind,label}`; labels that look like URLs, long digit runs or
secrets drop; a sensitive mark drops while inference stays off; contacts
stayed off so contact items are dropped unread), `TopicPool` (per-app
day evidence, strength×retention scoring, `maintain` forgetting, an
unticked app loses its evidence), `qualifiedTopic`/`renderObserved`
(topics-only `ObservedContext`: only days backed by `intoTasks`-tier
apps count; the section carries Mika's honesty header).

`server/host/notice-learn.ts` is the runner slice: event-driven like the
triage runner — one batch in flight, a failed batch drops its events and
holds by consecutive failures, 20 judge calls per owner per day, the
same `noticeJudge` general model. `host/phones.ts` feeds it on every
kept notice (with the dedup's new-message lines), purges buffer +
pool evidence on untick, and persists the pool per owner at
`dataDir/notice-topics/<owner>/topics.json`. `promptParts` appends a
`device-notices` part when `renderObserved` qualifies.

Left out, as the gap doc keeps out: contacts/relations, the
notes→day→week→month digests, `NoticeJournal` persistence of raw
notices, open/dismiss outcome tracking (the phone posts on arrival and
cannot see removal reasons), and the user's topic-management surface —
so `blocked`/`merged` name maps are unported. Per-app `SourceTier` is
hard-wired `mid` until a Settings row exists, meaning `balanced` shows
nothing; `aggressive` is the first level that surfaces Mid-tier topics.

## Verification

Phase 1/1b: unit tests beside `server/phone-routes.test.ts` for `settle`
(success clears, same-step misses retire, elsewhere resets, `used` touches
only) and beside `server/phones/host.test.ts` for the end-turn settle
(success, unchanged-call miss, refused-only and stopped settle nothing);
`vitest run` the phones directory; `oxlint` the touched files.

Phase 2: `server/host/phones.test.ts` drives the gate through `promptParts`
(three verdicts on the route part, one question a turn, non-person turns
skipped, no candidate no question, judge fallback, no wiring no gate) and
`server/phones/host.test.ts` drives the tool-call gate (DISCUSS refuses the
first call before any job reaches the phone).

Phase 3: `server/routes/phones.test.ts` for the `phoneData`-vs-`messages`
grant split and the notice wire bounds; `server/host/phones.test.ts` for
ingestion (whitelist keep, non-whitelisted/sensitive/repost drops, untick
pruning, sms/wechat handlers untouched, grant enforcement);
`NoticeEventTest` (Robolectric) for the extraction drops and MessagingStyle
fields. `pnpm typecheck`; `:app:compileDebugKotlin`;
`:app:testDebugUnitTest`.

Phase 3b: `server/host/notice-triage.test.ts` — the parser (last-JSON
ending, unknown/duplicate/missing/invalid ids, no-JSON batch failure, a
quoted record never counting) and the runner (gathering window, judged
marks, one surface delivery, failed-batch cooldown, no-judge no-op, busy
holding a full batch).

Phase 3c: `server/notice-learn.test.ts` — buffer (repeat window, due,
begin/fail/finish, purge), parser (cite/new, every drop reason, no-JSON
batch failure, contact items ignored, sensitive dropped), pool (one-day
per judgement, same-name cites, forgetting, clearApp, strongest), and
`qualifiedTopic`/`renderObserved` gating. `server/host/notice-learn.test.ts`
— the runner (aged batch judged and persisted, waiting timers, failure
hold, unreadable reply, level off, no judge, purge, busy).
