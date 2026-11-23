# Mika gap analysis

## Why this exists

Mika ([wangzan101/Mika](https://github.com/wangzan101/Mika), Apache-2.0) is an
Android agent app: one APK that drives the phone it is installed on, in a
virtual display of its own, and ships its own decision model client, loop
guards, notification learning, experience replay and self-check. Luna Bot is a
TypeScript server with an Electron desktop app and a Kotlin Android companion:
the server runs turns, and the phone is a paired device the server sends jobs
to. We compared the two and ported the parts of Mika that fit that split.

This batch added ten phone tools, a second approval gate for irreversible
screen controls, a loop guard, and the pure modules behind them: the
irreversible detector and grant (`shared/irreversible.ts`), the loop guard
(`server/phone-guards.ts`), notification learning (`server/phone-notices.ts`),
the intent gate (`server/intent-gate.ts`), route replay
(`shared/route-replay.ts`), pacing (`PhoneUiPacing.kt`), and self-repair plus
self-check (`PhoneUiSelfRepair.kt`, `PhoneUiAccessibilityRepair.kt`,
`PhoneUiSelfCheck.kt`). Everything that needed a surface we do not have —
Mika's shell command tool, its overlay capsule, its on-device Linux sandbox —
was left behind and is listed under "What is still missing" with the reason.
The upstream attribution for every ported file is in
`third_party/mika/README.md`; this document is the engineering record of what
changed and how to check it.

## Decision model

Our decider already reached further than Mika's. `server/decider/types.ts`
defines seven seams: the five jobs in `DECIDER_JOBS` (`roomRouting`,
`inboxTriage`, `browserClicks`, `toolSelection`, `placement`), a bot's own
`botDecide` call, and `keyCheck` for the Settings test button. Mika's decision
model has two call sites in production code plus the Settings connection test:
`IntentGate.assess` and `RouteMatcher.choose`, both in
`core/src/main/kotlin/com/wangzan101/mika/core/agent/` and
`core/src/main/kotlin/com/wangzan101/mika/core/replay/`.

What was missing was not a seam but where Mika puts one: two judgements made
before the first model turn, on a fixed question the caller supplies, with a
hard probability floor. Mika's `DecisionPolicy.MIN_PROBABILITY` is 0.85.

| Seam | Mika | Us before | Us now |
| --- | --- | --- | --- |
| Who answers in a room | none | `roomRouting` job | unchanged |
| Inbox triage | a general chat model (`proactive/NoticeTriage.kt`), not the decision model | `inboxTriage` job | unchanged |
| Browser click choice | none | `browserClicks` job | unchanged |
| Tool selection | none | `toolSelection` job | unchanged |
| Where work runs | none | `placement` job | unchanged |
| A bot's own question | none | `botDecide` | unchanged |
| Key check | Settings test only (`testDecisionConnection`) | `keyCheck` seam | unchanged |
| Chat-entry intent | `agent/IntentGate.kt` | none | `server/intent-gate.ts` |
| Route choice before replanning | `replay/RouteMatcher.kt` | none | `needsDecision` hook in `shared/route-replay.ts` |
| Probability floor | `core/decision/DecisionModel.kt` (`DecisionPolicy.MIN_PROBABILITY`) | none for this question | `INTENT_MIN_PROBABILITY = 0.85` |

Three artifacts of Mika's were adopted. The first is the intent question in
`server/intent-gate.ts`: a three-way choice asked before the first tool call,
with Mika's option meanings and instructions. The second is the decision point
before replay: `needsDecision` says when a classifier has to choose, and
Mika's `skip` option ("do not reuse a route") is not carried, because our
module leaves the choice to the caller. The third is the policy around both:
`DecisionPolicy.MIN_PROBABILITY` and the 10 s budget became
`INTENT_MIN_PROBABILITY` and `INTENT_GATE_TIMEOUT_MS`.

Mika's own docs (`docs/models.md`) name the same two production uses: the
chat-entry intent judgement and history route selection when experience replay
is on. We kept both as pure modules with the policy constants, but neither is
called in a turn. Nothing calls `assessIntent` and nothing calls
`needsDecision`, so today they change no behaviour at all. See "Intent gate" and
"Route replay" below.

Mika's route question also asks for a second number, `applicable`, and requires
both it and the choice probability to clear 0.85. Our `ChoiceAnswer` carries
`pTop`, `margin` and `probabilities` and nothing else, so a caller of
`needsDecision` can check one probability only. If route replay is ever wired
up, that second score has to be either added to the decider or dropped on
purpose.

Mika's inbox triage is not one of those two: `proactive/NoticeTriage.kt` takes a
plain `ChatModel` and asks it for JSON, and
`app/src/main/java/com/wangzan101/mika/proactive/TriageRunner.kt` builds it with
the ordinary model. Our `inboxTriage` seam is therefore ahead of Mika rather
than a port, which is why the table's Mika column says "a general chat model"
for that row. Its key-check equivalent is `testDecisionConnection` in
`app/src/main/java/com/wangzan101/mika/ui/JevSettingsScreen.kt`, one fixed
two-option question.

## Phone execution

`PHONE_TOOL_NAMES` in `shared/phone-apps.ts` now holds 52 tools. The stale
build in `dist-server/shared/phone-apps.js` (gitignored output, older than this
change) lists 42; the difference is the ten below. The input schemas
are in `server/phones/tools.ts`, the write sentences in
`server/phones/summary.ts` and `server/chat-notices.ts`, and the prompt text in
`server/phones/instructions.ts` (`PHONE_INSTRUCTIONS` and `PHONE_PROMPT` both
name the new tools).

| Tool | Capability | Read/write | What it adds |
| --- | --- | --- | --- |
| `PHONE_UI_COLLECT` | phoneUi | write | Reads several screens in one call, scrolling between them, and stops at the end of the list. |
| `PHONE_UI_RUN` | phoneUi | write | Runs up to 20 screen commands in one call and stops at the first failure. |
| `PHONE_UI_QUERY` | phoneUi | read | Narrows the current snapshot by text, view id or role, so a long screen costs one answer. |
| `PHONE_UI_FIND` | phoneUi | write | Scrolls until a target appears or the content stops changing, and returns its refs (Mika's `phone_find`). |
| `PHONE_LIST_APPS` | phoneUi | read | Lists launcher apps with their real package names for `PHONE_UI_LAUNCH`. |
| `PHONE_SET_ALARM` | phoneUi | write | Sets an alarm through the Clock app's own intent, with `EXTRA_SKIP_UI` so no editor opens. |
| `PHONE_SET_TIMER` | phoneUi | write | Starts a countdown timer the same way. |
| `PHONE_OPEN_LINK` | phoneUi | write | Opens an http or https link on the controlled display, not the person's own screen. |
| `PHONE_SHARE_TEXT` | phoneUi | write | Puts text into another app's compose screen, which the person still sends. |
| `PHONE_UI_AFTER_TASK` | phoneUi | write | Chooses whether the app a task drove is kept or finished when the task ends. |

The Android build serves 47 of the 52: `android/core/src/main/kotlin/com/openmausbot/companion/core/PhoneJobs.kt`
has no `PhoneTool` entry for `PHONE_RESPOND_TO_INVITE`,
`PHONE_FIND_PLACES_NEARBY`, `PHONE_LIST_HOME`, `PHONE_SET_ACCESSORY` or
`PHONE_RUN_SCENE`, so those five answer `unsupported` from
`PhoneToolCatalog.capabilityOf`. None of the five is a phone-UI tool, so every
one of the ten new tools is served. That file also carries `PHONE_REPLY_SMS`,
which is the SMS relay's own reply job and is not in the server's tool list.
All ten are registered in the executor's `actionOf` map in
`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiTaskExecutor.kt`.

### `PHONE_UI_RUN`

`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiRun.kt`
runs a list of `launch`, `tap`, `type`, `scroll`, `swipe`, `key`, `back`,
`wait`, `assert` and `observe` steps. Each step takes a fresh snapshot first and
finds its target again on the current screen: a `ref` from an earlier observe is
a hint, resolved through the identity recorded before the first snapshot
(bounds plus view id, text or description), never a promise. A selector that
matches several elements is accepted only when exactly one of them is
clickable. The run stops at the first failing step, reports `stopped` and
`stoppedAt`, and returns the screen it ended on, so the bot needs no follow-up
observe. This replaces a chain of single actions: a five-step form costs one
round trip instead of five, and each step is still re-verified on the screen it
actually runs on.

A run cannot carry an irreversible step. `server/phones/confirm.ts` resolves the
first step the word list names against the last screen the phone showed and
refuses the whole call (see "Irreversible actions"). A step whose target is not
on that screen cannot be judged and is passed over, because the run finds it on
a later screen the server has not seen.

`server/chat-notices.ts` has a `chat.notice.phone.write.PHONE_UI_RUN` key, so
the activity row for a run reads "Run several steps on <phone>". All eight new
write tools (`PHONE_UI_RUN`, `PHONE_UI_COLLECT`, `PHONE_UI_FIND`,
`PHONE_SET_ALARM`, `PHONE_SET_TIMER`, `PHONE_OPEN_LINK`, `PHONE_SHARE_TEXT`,
`PHONE_UI_AFTER_TASK`) have their own sentence, in `server/chat-notices.ts` and
in both `src/locales/en.json` and `zh.json`; `PHONE_UI_QUERY` and
`PHONE_LIST_APPS` are reads and post no activity row.

The screen writes that predate this batch get one too: `PHONE_UI_TAP_AT`,
`PHONE_UI_SWIPE`, `PHONE_UI_KEY`, `PHONE_CLIPBOARD_SET` and
`PHONE_FILE_SHARE` are in `phoneWriteSummary`'s `WRITES` set now, so their rows
name the action instead of falling back to the bare `describeAction` sentence.
`PHONE_FILE_SEND` stays out on purpose: handing a file to the share sheet is a
read in `shared/outbound.ts`, because nothing leaves the phone until the person
picks a target. The generic fallback in `summary.ts` remains for any future
write the packs have no words for yet.

### `PHONE_UI_COLLECT`

`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiCollect.kt`
reads the current screen's text band, scrolls one step, and reads again, up to
20 pages and 1000 lines. The scroll it is handed already waits for the screen to
change, so the collect's own "settle" step only reports whether that scroll
moved anything. A line counts only when it lay wholly inside the band on the
screen it came from, so a line cut by an edge is not returned half read and then
again; a line already returned is never repeated. The read stops at the page or
line bound, at the end of the list (two scrolls that brought nothing new), when
another app comes in front, when the screen stops changing, or when a scroll
fails. It scrolls, so it is a write and asks the person first, like any other
screen action.

`direction` is where the content moves, matching `PHONE_UI_SCROLL`: `down`
follows the list to newer content below and the finger travels up. It is not
`PHONE_UI_SWIPE`'s meaning, which names the finger's own direction.

### `PHONE_UI_QUERY`

`PhoneUiTaskExecutor.query` filters the same snapshot `PHONE_UI_OBSERVE` reads,
by text (against text or content description), view id and class name, all
case-insensitive substrings. Every filter given must hold. The answer reports
`count` before `limit` and `truncated`, so "nothing there" and "more than
shown" stay distinct. Its refs work with `PHONE_UI_TAP` and `PHONE_UI_TYPE`. It
is read-only and does not ask.

### `PHONE_UI_FIND`

`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiFind.kt`
is Mika's `phone_find` (`PhoneFind` in
`core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneAdvancedTools.kt`)
ported to this tool surface: it scrolls the current screen until an element
matching `text`, `resourceId` or `role` (at least one) is found, and returns
the matches with refs, so the bot can tap them with `PHONE_UI_TAP` or type into
them with `PHONE_UI_TYPE`.

The loop reads the screen, asks the same matcher `PHONE_UI_QUERY` uses, and
scrolls one step in `direction` when the target is not there, up to
`maxScrolls` (1–200, default 30). It stops as `found`; as `scroll_limit` when
the scroll budget or the call's 30 s time budget runs out; as
`content_unchanged` when two readings in a row carry the same visible element
tuples; as `app_switched` when another app comes in front; as `read_failed`
when no snapshot could be taken; as `screen_needs_review` when the snapshot is
empty or its package cannot be read; and as `scroll_failed` when a scroll step
did not happen. The answer carries `ok`/`found`, `stoppedBecause`, `scrolls`,
`total`, `truncated`, the `query` it ran, the elements with refs, the snapshot
and package it stopped on, and — beside the match list — the whole screen it
stopped on as `screen`.

That last field is why `PHONE_UI_FIND` is in `confirm.ts`'s `SCREEN_ANSWERS`
even though it answers with a filtered list: the refs it hands out belong to
that snapshot, so the server records the screen and a later `PHONE_UI_TAP`
naming one of those refs is judged against what the phone actually showed. A
match-only answer would leave the stored screen stale, and the irreversible gate
can only judge elements it has seen — a control a find surfaced would slip past
it.

Three divergences from Mika, all deliberate and recorded in the file's header:

- **One step per iteration.** Mika calls `phone_scroll` with `amount: 3`;
  `PHONE_UI_SCROLL` here takes one step, so each iteration scrolls one step
  and `maxScrolls` is the whole budget rather than a count of sub-actions.
- **No protected/readable screen flag.** Our snapshot has no protection flag,
  so the two verdicts Mika reads from it are approximated: a null snapshot is
  `read_failed` (nothing was read), and an empty tree or an unreadable package
  is `screen_needs_review` (the read worked but there is nothing we may act
  on). The loop never scrolls a screen it cannot see.
- **Two identical readings, not three.** Our scroll already waits for the
  screen to change, so one equal comparison after a scroll is a real answer
  where Mika's fire-and-forget scroll needs a third reading to be sure.

The fingerprint hashes the visible element tuples — class, text, description,
view id and bounds in reading order — and ignores refs and snapshot ids, so a
re-read of the same content compares equal and a list that moved without
changing reads as unchanged. Bounds are included because a row that moved is a
different screen.

It scrolls, so it is a screen write: it holds on the outgoing-action card like
`PHONE_UI_SCROLL` and `PHONE_UI_COLLECT`, is in `PHONE_UI_WRITES` in
`shared/outbound.ts`, and is not in `KNOWN_READ_SLUGS`. On the phone it does
not go through the executor's `write()` wrapper, because that wrapper takes one
more snapshot at the end, which would rotate the ref registry and invalidate
the refs the loop just returned; it pays the same dwell, opens the same display
session, and runs the same spill check.

### `PHONE_LIST_APPS`

`PhoneUiTaskExecutor.listApps` lists installed applications that have a launcher
intent — the same test `PHONE_UI_LAUNCH` applies — with label and package name,
sorted by label. It is answered before a display session or the shell helper is
acquired, so it works on a phone whose helper is not up. It is read-only.

### Pacing

`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiPacing.kt`
ports Mika's `OperatingPace`, `TypingPacing`, `GesturePacing`, `AppPacing` and
`uistate/Pace.kt`. Three levels: `FAST`, `STANDARD` and `HUMAN`. It plans typing
as growing prefixes with per-character waits and CJK grouping, jitters a tap
inside its element, bows and eases a swipe, and computes a dwell between actions
that counts the time the model spent thinking. Every duration is clamped by a
`PhoneUiPaceLimits` value; randomness and the clock are parameters, and nothing
sleeps.

It is wired into `PhoneUiTaskExecutor` as opt-in. The executor starts on
`OperatingPace.FAST` with `GesturePace.Instant`, `TypingPace.Instant` and
`ActionPace.Off`, which reproduce the old touch exactly: centre point, 50 ms
press, a straight eight-segment stroke, the whole string in one write, no dwell.
`setPace` is the only way to change that, and nothing calls it: a search of
`android/` finds its definition and no call site. No settings screen exposes a
pace, and no preference is read. A FAST run is therefore byte-for-byte the
behaviour before this module existed.

Note that `OperatingPace.DEFAULT` in `PhoneUiPacing.kt` is `STANDARD`, not
`FAST`, because that is Mika's default. The executor does not use it. If you
wire `setPace` to a setting later, decide deliberately whether the setting
defaults to `FAST` (keep today's behaviour) or to `OperatingPace.DEFAULT`
(change it for everyone).

## Irreversible actions

`shared/irreversible.ts` is the detector and the grant. It reads one element's
own words and classifies it as `pay`, `order`, `delete` or `send`.

- **Word list.** A closed Chinese table (`支付`, `付款`, `转账`, `删除`, `撤回`,
  `下单`, `购买`, `结算`, `结账`, `取消订单`, `确认收货`, `退款`, `转发`) searched
  anywhere in a short name, or in one whitespace-separated segment of a composed
  name; a name over 12 whitespace-stripped characters is not searched whole.
  Resource-id words (`send`, `reply`, `pay`, `delete`, `remove`, `checkout`)
  after the last `/`, split on `_ - .` and camel case. A generic `确认`/`确定`/
  `ok`/`完成`/`confirm` counts only when the rest of the screen names an action
  or a payable amount.
- **Status-word exclusions.** A hit preceded by `待` or `已` is a status, not an
  action; a hit followed by `成功`, `记录`, `售后`, `明细`, `方式`, `列表`, `中心`,
  `入口` or `码` is an entry, not an action. `支付宝`, `支付方式` and `支付设置` are
  removed before matching, and payment-method descriptions on a product page
  (`支持…付款`, `货到付款`, `花呗`, `分期`, …) are stripped.
- **English divergence.** The English table matches a whole label only, after
  trimming, lowercasing, collapsing spaces and dropping trailing punctuation.
  Mika's table matches any label that starts with the word, so "Send message to
  Alice" counts there and not here. Exact equality is also what keeps "Payment
  history", "Purchase history" and "Sent" out.
- **Signals.** An enter key on a focused field that is not a search box is a
  send; an enter key that activates a send button is a send; a horizontal swipe
  starting on a clickable, non-scrolling, wider-than-tall row is a delete.
  Tapping an editable or password field is never an action.

`ConfirmGate` keeps the person's approval as a one-shot grant bound to the app,
kind, target, text and amount they approved. The grant is consumed by the next
hit whether or not it matches, survives typing only, and is voided by any other
write or by `MAX_STEPS` (3) steps. A refusal is remembered per kind and app for
the life of that gate. A `pay` hit is never approvable: `declare` returns
`unsupported` before anything else.

The host wiring is in `server/phones/host.ts` and `server/phones/confirm.ts`.
For every phone screen write, `createPhoneHost` first holds the call on the
outgoing-action card (`holdOutbound`), which is the person's approval of that
tool call. The card's approval is then handed to `PhoneConfirms.approveCard`,
which classifies the control, turns it into a one-shot grant for exactly that
step, and records one card per kind per app in the gate. `check` consumes the
grant. So the card *is* the approval: one card buys one classified step, and a
second step of the same kind in the same app in the same conversation is refused
rather than carded again.

Two consequences of that design are worth knowing. `holdOutbound` returns
`approved: true` only when it showed a card and the person allowed it, and
`host.ts` does not read that field: `approveCard` treats any call that got past
the hold as approved. So at Full access, and for a bot whose outbound policy is
`allow`, the card is skipped and a classified non-pay step is granted with no
person involved, which matches what Full access means for a send. `pay` is
still refused there, because `ConfirmGate.declare` refuses the kind before any
grant exists. Second, the approval covers one call: a later classified step of
the same kind in the same app in the same conversation is refused with the
"already used" sentence below, which is the one-card-one-step rule the code
documents.

The refusal sentences, verbatim from `server/phones/confirm.ts`:

- A payment: ``Not run: ${controlWhat(input, hit)} is the irreversible action "pay", and a payment is never approved for a bot here. Ask the person to make the payment themselves.``
- A run carrying a payment step: ``Not run: ${step}, and a payment is never approved for a bot here. Run the other steps with PHONE_UI_RUN, and ask the person to make the payment themselves.`` where `step` is ``this PHONE_UI_RUN includes ${controlWhat(input, hit)}, the irreversible action "${hit.action}"``.
- A run carrying any other classified step: ``Not run: ${step}. Run the other steps with PHONE_UI_RUN, then that one step alone, so the person sees a card for exactly that.``
- An unapproved step: ``Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and the person has not approved this exact step${why}. Ask the person first with the confirmation tool, then try the step again.``
- A grant already spent: ``Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and one approval of this kind was already used in this task. Ask the person again with the confirmation tool, then try the step again.``
- A screen that moved: ``Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", but the screen changed or the app in front is not the one the card was approved on. Ask the person again.``
- A step refused earlier: ``Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and the person refused it earlier in this task. Ask the person what they would like instead.``

`controlWhat` renders `pressing the enter key`, `this swipe`, or
`tapping <the matched label>`.

A coordinate tap is resolved to the smallest element under the point before it
is classified, and a run is resolved to its first classified step on the current
screen, so neither is a way around the gate.

One honest limitation: several sentences tell the bot to "ask the person first
with the confirmation tool", and no such tool exists in this repo. Mika has
`general/RequestConfirmation.kt`; we have only the outbound card. That is the
one place a future maintainer should expect to add the missing tool rather than
to widen the gate.

The gate's state is per turn, not per conversation: `ConfirmTurn` carries the
turn's `generation`, and `PhoneConfirms.state` hands a turn with a different
generation a fresh gate, so a grant, a remembered refusal and a spent card all
die with the turn that made them. `generation` is optional because the
`ConfirmTurn` shape predates it; a caller that omits it gets one gate per
`(threadId, botId)` for as long as the entry lives. The map still evicts its
oldest entry past `MAX_CONFIRM_TURNS` (200).

## Loop guards

`server/phone-guards.ts` ports Mika's `OperationGuards`, `GuardRules` and
`Fingerprints`. Each screen write is fingerprinted before it is queued, and an
answer that carries the whole screen is recorded after it — including a
`PHONE_UI_COLLECT`, whose answer carries the screen it stopped on, so a collect
counts as progress rather than as a repeat.

- **Signature normalisation.** `actionSignature` drops the free-text `reason`,
  floors a tap's `x` and `y` onto a 50-pixel grid, collapses a swipe's four
  endpoints to a direction code (`V-`, `V+`, `H-`, `H+`) and canonicalises JSON
  object keys at every depth. Two calls that differ only in wording or by a few
  pixels are the same action. Verified by hand: `{x:101,y:203,reason:"a"}` and
  `{y:203,x:101}` both read `PHONE_UI_TAP_AT|{"x":2,"y":4}`.
- **Three ladders.** The same action on an unchanged screen warns at 3 and 6 and
  stops at 12 (`repeatLadder`). Actions with no screen change, whatever their
  signature, warn at 3, 6 and 9 and stop at 12 (`unchangedLadder`). Whole
  rounds through 2–3 screens warn at 2 and 4 and stop at 12 (`cycleLadder`). The
  repeat rule is the more specific one and is reported in preference to
  no-progress; a cycle is reported only when neither of the other two fired for
  that action.
- **The stop.** Once a turn has stopped, every later screen write in it is
  refused with ``Not run: this task is stuck on the phone (${verdict.code}), and the same action again will not move it. Stop here and report what is done and what is still blocked.`` A guard is per (thread, bot) and per turn generation; a new turn starts fresh even though the phone's last screen stands.
- **The nudge.** A warning lets the call run. `withNudge` in
  `server/phones/host.ts` appends it to the answer under the same `note` key the
  phone's own answers carry, keeping any note the phone wrote in front of it. A
  failed call keeps its own sentence instead: its nudge would claim the screen
  did not move, which a failure does not say.

Thresholds are Mika's, not measured against our tools, and are marked
provisional in `PHONE_GUARD_LIMITS`. Not ported: the off-screen guard and its
quotas, the read-loop guard, the tool-failure ladder, the separate same-state
visit counter, the diagnostic-tool repeat ladder, and the budget-scaled stops.
Only a run of consecutive identical actions counts, because a repeat broken by a
different action is already counted by the unchanged ladder.

## Notifications

`server/phone-notices.ts` is the pure learning core of Mika's `core/proactive`
package: `NoticeInbox` (a bounded in-memory store with per-key line history and
per-local-day received/kept counters), `shouldLearn` (package whitelist, this
app's own packages, app access, authentication secrets, ongoing/group-summary/
foreground-service/not-clearable/category/blank exclusions), `sanitizeNotice`
and `cleanNoticeText` (control characters, bidi and invisible format characters,
whitespace collapse, surrogate-safe truncation), `createNoticeDedup`
(MessagingStyle message fingerprints with a clock-skew rule), `planTriage` and
`decideTriage` (the send/wait/idle decision with Mika's ordering: in-flight,
locked, nothing, budget, busy), `LEARN_LEVELS`, `learnableTopic` and
`NOTICE_TUNING`.

It deliberately is not the model client and not the storage. There is no HTTP,
no prompt building, no reply parsing, no journal, no codec. Mika's
`NoticeShapes` (splitting a chat notification into conversation, speaker and
line), `LiveUpdates`, `CatchUp` and the shade reconcile, `LearnBuffer`,
`TopicPool`, `ContactPool` and `NoticeJournal.kt` stay out; a caller supplies
`retainKeys`, marks and cooldowns.

Both halves now have callers. Ingress: the phone pushes each notification
from apps the person ticked (`registration.noticeApps`, `notice` events on
`/api/phones/self/events`, `phoneData` grant); `server/host/phones.ts` keeps
a per-owner `{ NoticeInbox, dedup }` and feeds it through `sanitizeNotice` +
`shouldLearn` against the registered whitelist. Consumer:
`server/host/notice-triage.ts` ports `NoticeTriage.kt`'s batch prompt and
strict parser plus the `TriageRunner` scheduling slice — one in-flight judge
call on the chief bot's engine, gathering window, busy/budget gates, and a
`surface` verdict delivered into a per-app chief thread via
`acceptDirectSend`. Divergences are deliberate and documented in the
module: no lock-screen signal (always unlocked, the daily call cap bounds
spend), in-memory marks/cooldowns pruned with the bounded inbox, and
Mika's token-ledger budget replaced by a per-owner daily call cap.

Mika's `NoticeShapes` (splitting a chat notification into conversation,
speaker and line), `LiveUpdates`, `CatchUp` and the shade reconcile,
`ContactPool`, `NoticeJournal.kt` and the notes→day→week→month digests
stay out; the runner supplies marks, cooldowns and first-seen clocks. The
learn pipeline has its caller: `server/notice-learn.ts` ports `LearnBuffer`,
`NoticeLearn` (topics only — contacts stay off), `TopicPool` and the
`ObservedContext` topics section, and `server/host/notice-learn.ts` runs
it per owner off `config.features.noticeLearn` (default off; conservative
learns without reaching tasks). Still absent: the user's topic-management
surface, per-app `SourceTier` (everything is `mid`), sensitive inference,
and open/dismiss outcomes — the phone cannot report a removal reason.

## Intent gate

`server/intent-gate.ts` ports Mika's `agent/IntentGate.kt` without the decider.
It asks one three-way question — `DISCUSS`, `READ`, `ACT` — with Mika's
meanings word for word and its instructions with the product name replaced by
"the assistant". The answer counts only when the choice is one it offered and
its own probability is at least `INTENT_MIN_PROBABILITY = 0.85`; that threshold
is Mika's and has not been re-validated against our providers, so it should move
only from a measurement of our own. The budget is `INTENT_GATE_TIMEOUT_MS =
10_000`, exported but not applied by this module (nothing here makes the call);
a caller passes it as the decider's `timeoutMs`. The prior conversation is
bounded to `MAX_CONTEXT_TURNS = 3` and `MAX_CONTEXT_TOKENS = 800`, clipped with
an ellipsis.

The fallback ordering is Mika's: the decision model's answer if it clears the
threshold, then the judge's single word (`parseJudge` strips one backtick from
each end, trims and folds case), then `{ intent: null, via: "none" }`. One
deliberate difference: neither callback is caught, so an ordinary failure has to
arrive as `{ ok: false }` or a null reply rather than a throw; a cancelled
decision must be thrown, and reaches the caller.

It is not wired into a turn. Nothing calls `assessIntent` or
`intentGateRequest` outside `server/intent-gate.test.ts`.

Wiring it needs one product decision this module cannot make for a caller: what
ACT means here. In Mika the gate decides whether the phone may be driven at all
before a tool is offered; in our split the same request may be a chat answer, a
phone job or a delegation, and the gate would sit in front of the turn's first
tool choice rather than in front of a whole turn. Its two cheap fallbacks — a
judge word, then no intent — also mean a wrongly-read DISCUSS would let a
screen write through, so the caller has to decide whether an ACT-only rule is
stricter than the approval gate we already have (it is not: the card is shown
either way). Until that is settled, the module stays the tested question and
its parser.

## Route replay

`shared/route-replay.ts` is the pure core of Mika's `replay/Route.kt`,
`RouteSlots.kt`, `RouteMatcher.kt`, `RouteRecorder.kt` and `agent/LearnGate.kt`.

- **Template and slots.** A route is the request with its variable parts
  replaced by `{1}`, `{2}`… `routeSlots` recovers the values and refuses an
  ambiguous split: too long, too many slots, ids not exactly 1..n, a blank fixed
  segment between slots, a value that is blank or appears more than once, or a
  search that ran past `MAX_SEARCH = 128` attempts. `routeCandidates` shortlists
  by character-bigram similarity (floor 0.3) or a matching package, best first.
  `needsDecision` says when more than one fits; the caller supplies its own
  classifier, because nothing here sends a request.
- **What `recordRoute` refuses to store.** Typed text becomes a slot only when
  it is one unique piece of the request; a fixed word, something the person was
  asked for, or a masked value makes the whole route unsaveable. A password
  field stops the route. A selector never carries an editable element's text:
  `storedName` returns empty for any editable element, so role, resource id,
  bounds and ordinal identify it instead. That can lose a field's hint, but it
  can never persist what the person typed. An anchor or stored name must be 1–12
  characters and contain no digit, currency mark or percent.
- **The LearnGate rule.** `learnable` requires learning on, an outcome of
  exactly `done`, a run id, no user-screen attachment (neither the `userScreen`
  flag nor a `[[screen:…]]` line), no unconfirmed value and no doubtful answer.
  `recordRoute` adds: not spoiled, no incomplete or protected step, no tool a
  route cannot replay, at least one write that did something, no overlapping
  slot spans, and a template that can be read back from this request.

`server/phone-routes.ts` is the recording and storage layer. `note` buffers a
turn's calls with the screen before and after each one; `finish` records only
when `learnable` holds, every step is replayable and at least one write did
something; a route is written to `DATA_DIR/phone-routes/<owner>/<id>.json`
(0700 folders, 0600 files, atomic, 50 per owner, 64 KiB each, corrupt files
skipped, never fatal). The owner folder is the key itself when it is already
`[A-Za-z0-9_-]{1,64}`, otherwise its SHA-256, so an email or a path can never
become a path. `match` shortlists by similarity or a matching package.

A whole run is refused when any step typed into an editable field, when a
password or code field appears, or when a `PHONE_UI_RUN` carries a nested `type`
command, because the pure core does not slot nested commands. Pairing codes
survive neither: `stableAnchor` already rejects anything containing a digit.

Replay itself is not built. Nothing fills a route's slots and feeds its steps
back to the phone, and `match` is exposed on the phones object but not injected
into a prompt, so a stored route is a record, not yet a shortcut.

## Answer verification

A phone bot's worst failure is not a missed tap but a confident "sent" after a
tap that did not send. `shared/verify-grounding.ts` is the model-free half of
Mika's `verify/Grounding.kt`: the quoted text, numbers with a unit or a
magnitude, decimals, three-digit integers, ids embedded in letters, dates and
times in an answer must each appear literally somewhere in the evidence. The
comparison folds NFKC, zero-width characters, citation marks and footnotes,
thousands separators, 万/亿 and punctuation, and it compares line by line so an
answer line is never joined to the next one. Ordinals are not values: `第N条`,
`前N`, `Top N`, `No.N`, `#N`, a leading list number and a leading number
followed by a name are all excluded, and 千 inside 千米/千克/千瓦/千卡/千帕/千焦
is a unit, not a magnitude. Two-digit integers without a unit are never checked,
and numbers already in the task prompt are known.

`server/answer-verify.ts` is the model half: `Criteria` (the person's own words
as the fallback standard, `read` or `irreversible`), `criteriaFor`,
`verifierRequest`, `parseVerification` and `verifyAnswer`, with the model call
injected so no provider or key is bound here. A model `pass` is downgraded to
`fail` when grounding finds an ungrounded fact, and everything else fails open
to `cannot_verify` with a reason — a timeout or a bad reply never throws and
never blocks a turn. `VERIFY_TIMEOUT_MS` is a flat 60 s.

Mika's relative-date resolution (今天/明天/周二 against a clock), arithmetic over
evidence numbers, the 约/≈ rounding tolerance, truncated-line detection and the
evidence-ledger excerpting with a retried, trimmed request are not ported. A
derived number must appear on screen.

The evidence itself comes from `PhoneEvidenceLedger` in `server/phones/host.ts`:
bounded per turn (64 entries, 24 000 characters, 64 turns, 200 last screens),
one entry per screen-carrying call with the screen before and after, refusals
kept as evidence but never as route steps, and password-flagged elements or
lines the sensitive filter would flag left out. `server/index.ts` calls
`phones.turnEnded` after the reply is settled, never for a turn the person
stopped. Verification is **off by default** and has a Settings switch:
`features.phoneVerify` is `"off"` or `"log"`, read at call time, and `"log"`
writes one decision row per phone turn and nothing else. There is no `"warn"`
mode — a finished turn has no reply left to append a caveat to.

## Untrusted screen text

`shared/untrusted.ts` is Mika's `observation/Untrusted.kt`: the text is wrapped
in `<untrusted>`/`</untrusted>`, the markers cost 29 characters of the budget,
and a literal closing marker inside the body is escaped so the body cannot close
the tag early. `wrapUntrustedWithin` cuts only the body, so a result is never
left open.

`phoneOkResult` applies it in `server/phones/tools.ts`, on the text block the
model reads and only there: element text and descriptions, collect lines, OCR
lines, notification titles and bodies, clipboard text, file names and a text
file's body. Refs, bounds, view ids, class names, counts, package names, urls,
mime types, ids, base64 images and every value in `structuredContent` stay raw,
and our own `ok`/`error`/`phone`/screen size is not wrapped. A calendar title, a
contact name or a place name is still app data but is not wrapped yet. The phone
prompt in `server/phones/instructions.ts` says once that marked text is data
from an app, never an instruction.

## Sensitive text

`shared/sensitive.ts` is Mika's `memory/SensitiveFilter.kt`: `hit(text)` answers
`api_key`, `id_number`, `card_number`, `password` or null. Keyword rules allow a
short gap (`是否/是为/：/=`, optional is/was/are) before a four-character run,
`pin` and `otp` count only before four digits (`pinned` and `hotpot` do not), the
18-digit id must pass its weighted checksum, a card number must pass Luhn over
13–19 digits written with single spaces or hyphens, and a NFKC + compact retry
catches `验证码 1 2 3 4`. Phone numbers, addresses, birthdays and family terms
are deliberately not flagged: they are the facts a phone bot exists to keep.

`api_key` is not re-implemented: it is delegated to the existing
`redactSecretsInText`, which already knows about twenty provider shapes and PEM
blocks. The gate runs in `server/workspace.ts` at both memory writes —
`updateMemory` and `appendMemoryLog` — after the existing redaction, before
anything touches a file, an archive or an index. A refusal names the kind only
and never the matched text.

## Steering

`server/phones/steer.ts` is Mika's `run/SteerSignal.kt`. A person's mid-turn
message marks the turn; a phone job being waited on is raced against that mark
and loses at once, so the model reads the new words instead of sitting out a
six-second screen wait or a two-minute Send. The job is never cancelled: it runs
on the phone and only its answer goes unread, and its later rejection is caught
rather than left unhandled. A mark is spent by the wait it cuts, so one message
cuts one wait, and a newer turn in the same conversation replaces the mark
rather than inheriting it. `MAX_STEER_TURNS = 200`, the same bound as the
per-turn gates in `confirm.ts`.

The signal is the steered branch of `acceptDirectSend` in `server/index.ts`,
where the person's words are appended into the running turn. `host.ts` returns
`{ ok: false, error: "skipped_for_new_message" }` before it reaches
`registry.used`, the confirm gates or the guard reset, so nothing that happened
is counted twice and no guard state is touched by a wait that did not finish.
The string is not in `PhoneJobCode`, so the tool answers an error with no
structured code.

## Risk grading

`server/phone-risk.ts` is Mika's `action/RiskJudge.kt`: `read`, `change`,
`external`, `irreversible`, `unknown`, from the tool and the irreversibility hit
already computed in `shared/irreversible.ts`. The rule worth keeping is Mika's:
an amount on a screen is page content, not a charge. A price, a salary range, a
discount, or an amount in a field the person typed into is never a payment
context; only an amount in the same row as a total label (合计/实付/应付/总计) or
a pay control, or payment-sheet wording with an amount, makes the looser kinds
irreversible. `send` is always `external`, `pay` and `order` are always
`irreversible`, `delete` is `irreversible`, and `share_text`/`file_share` count
as `external` because the content leaves our hands.

This module grades only. It grants nothing, and `pay` is still refused outright
by `ConfirmGate.declare`. The grade is not yet fed into the refusal wording or
the decision log.

## Self-repair and self-check

`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/PhoneUiSelfRepair.kt`
is Mika's wireless-debugging auto-on as an immutable state with pure
transitions: write `adb_wifi_enabled` at most 3 times per episode, wait 3 s to
see whether the system flips it back, back off 10 s, 20 s, 40 s up to 5 minutes,
and stop with `NotAllowedHere`, `Refused` or `GaveUp`. A write that is flipped
back stops the loop rather than retrying, because every write pops the system's
"allow wireless debugging on this network?" dialog.

`PhoneUiAccessibilityRepair.kt` is Mika's `AccessibilityRepair` and the
`AccessibilityList` half of `RecoveryPermissions`: `enabled && !connected` is
the repair case, a service the person turned off is never written back silently,
and a listed-but-dead service is removed and re-added with a 1 s gap so the
system sees two writes. The list is shared with every other accessibility
service on the phone, so `settingWith` only appends our component and
`settingWithout` removes nothing else.

`PhoneUiSelfCheck.kt` runs a fixed probe list in order — `device`,
`permissions`, `helper`, `virtual display`, `app launch`, `screen reading`,
`actions`, `stays alive`, `main screen`, `browser`, `sandbox`, `app copies` —
with per-probe timeouts, a 90 s budget, dependency skips, and a report whose
verdict is `Pass`, `Fail` or `Incomplete`.

All twelve probes are real. `PhoneUiProbes.kt` holds the seams a probe runs
through (`ProbeShell` over `PhoneUiShell`, a display it opens and releases
itself, the launcher listing, a bounded wait) and one judge per row;
`phoneUiProbes(...)` assembles the map from the helper bridge, the
accessibility service and `PhoneUiDisplaySession`. A probe that cannot reach a
verdict — no browser installed, the helper gone mid-run, an empty snapshot —
fails or comes back incomplete with a sentence, never a pass. The runner has a
caller: the 自检 row in Settings runs it on a background thread and shows the
report in a sheet, with a spinner that refuses a second tap during the 90 s
budget.

Both repairs are wired as well. `PhoneUiController` owns one
`PhoneUiRepairLoop` (kept across recomputes, so its backoff and write budget
survive a status change) and starts or cancels it from the `phoneUi`
preference: the person's capability switch is the authorization for every
effect here, and `disable()`/`forget()` cancel it. The loop performs at most one
action per pass with a 2 s floor: the wireless half first, the accessibility
half only when that one did nothing.

The accessibility half repairs `enabled && !connected` by rewriting the list
through the helper's allow-listed `putSecureSetting`, and never writes when the
person turned the service off. The wireless half is the one place the app may
hold a system-write permission, and it is opt-in: a Settings switch, off by
default, whose on state is persisted as `companion.prefs.phone.repair.wireless`.
While a helper is attached the loop asks it for exactly one grant
(`WRITE_SECURE_SETTINGS`, for the caller's own package, via a fixed `pm grant`
argv), and from then on the app writes `adb_wifi_enabled` itself. With the
switch off, or with no grant and no helper, the loop folds no event at all —
`PhoneUiRepairLoop.wirelessWriter` keeps an absent writer from being recorded as
`Refused` and spending the write budget, so a reboot leaves the phone ready for
the helper's return instead of blocked until a manual retry.

## WeChat channel

The phone owns the transport; the server owns the turn. Mika's channel lives in
its app because its agent does. Ours splits the same way the SMS relay already
does: `WechatRuntime` long-polls iLink and pushes
`{kind:"wechat", sendId, from, text, images}` to `/api/phones/self/events`, the
server runs a normal turn, and the reply comes back as a `PHONE_REPLY_WECHAT` job
the phone sends itself.

What iLink is: Tencent's bot API — `get_bot_qrcode`, `get_qrcode_status`,
`getupdates`, `sendmessage`, `getuploadurl`, with a bearer token from a QR the
person scans. It has no contacts, groups, moments, payments or "send as the
person"; those are refused rather than faked, in the same places Mika refuses
them.

Ported: the owner-only DM filter (`message_type == 1 && groupId == null && from
== the bound owner`), `sendId` dedupe that survives a cursor rewind, backoff
1/2/4/8/16/30 s, 401/403 → rebind, image download → AES-128-ECB decrypt →
signature sniff → size cap → re-encode, one image per outbound message, and a
Keystore AES/GCM token.

Two divergences. The host is pinned to `ilinkai.weixin.qq.com`, and the `baseurl`
the bind response returns is parsed and discarded — Mika sends the token to
whatever host that response names, which lets a hostile login redirect it. And
there is no outbound rate limit, which is Mika's behaviour too: the only guards
are dedupe and failure backoff.

The QR encoder is ours, not ported, because zxing is not on the offline build
path: ISO/IEC 18004 versions 1–20, level M, byte mode, with golden matrices
checked against a decoder and Reed–Solomon syndromes before they were pinned.

The server side is `server/wechat-relay.ts`, a sibling of `sms-relay.ts`: one
thread per (phone, peer), the same `acceptDirectSend` and routine guards, dedupe
on `sendId`, and one reply per bot text of a successful turn. Inbound images are
saved through `saveImage` and attached with the composer's tag, so the turn gets
them as native image input. It is gated on `cfg.wechat.botId` and has no
Settings UI yet, so it is a file or environment setting.

## Device unlock

Mika's `DeviceUnlockInput` types the keyguard credential into the SystemUI
window. Ours does the same through four new helper transactions —
`wakeDevice` 20, `revealKeyguard` 21, `enterDeviceCredential(kind, bytes,
clear)` 22, `tapKeyguard` 23 — and the existing transaction range gate covers
them.

The injection targets the **SystemUI uid**, never a display, and only while
`isKeyguardLocked && isDeviceLocked`; every key re-checks that, so an unlock that
completes mid-sequence cannot send the rest of the credential into the app
underneath. It needs Android 13's hidden
`injectInputEvent(event, mode, targetUid)`; below that `canReachKeyguard()` is
false and nothing is injected, rather than an untargeted key landing wherever
focus happens to be.

The credential is entered on the phone, kept AES/GCM under a Keystore key with a
revision, zeroized after use, and never a job argument, a result, a log line or
anything the computer sees. Remote unlock is off until the person saves a
credential and turns the switch on; a failed attempt blocks further ones until
the person unlocks by hand or saves it again. A `phoneUi` job unlocks first when
the switch is on and the phone is locked; a refusal is logged and the job still
runs, because a virtual display often works while the device is locked.

Not ported: Mika's `wm dismiss-keyguard` (the helper keeps its no-command rule)
and its `TaskUnlockPolicy` origin rules — ours is one switch, and a channel turn
here is already owner-only.

## What is still missing

| Capability | Mika's files | Why not ported |
| --- | --- | --- |
| Storage glue | `core/.../adb/` identity types (`AdbIdentitySource`, `AdbKeyState`, `AdbKeyStore`, `WrappedKeyFile`), `replay/FileRouteStore.kt`, `replay/RouteStore.kt`, `proactive/NoticeJournal.kt`, `app/src/main/java/com/wangzan101/mika/record/RunStore.kt` | Route storage is built, as `server/phone-routes.ts` rather than Mika's `FileRouteStore`: per-owner folder, 0700/0600, atomic, bounded. `NoticeJournal`, `RunStore` and the ADB key store stay unported: our state lives server-side (the gates in `PhoneUiConfirms`, the phone registry), and the ADB key store stays app-side by design, as `third_party/mika/README.md` records. |
| Model client | `core/src/main/kotlin/com/wangzan101/mika/core/agent/ModelCaller.kt`, `ModelRouter.kt` | Not built: `server/decider/` already owns every model call we make, with keys, logging, relay and fail-open. A second client on the phone would duplicate it. |
| Android notification-format parsing | `core/src/main/kotlin/com/wangzan101/mika/core/proactive/NoticeShapes.kt` | Not built: our phone posts flat `title`/`text` through `PhoneNoticeStore`, which reads `EXTRA_TITLE`, `EXTRA_TEXT` and `EXTRA_BIG_TEXT` only. Splitting MessagingStyle conversations needs a phone-side parser we do not have. |
| Screen port and snapshot plumbing | `core/.../uistate/ScreenPort.kt`, `ScreenSession.kt`, `AppAccessScreenPort.kt` | Not built: `PhoneUiDisplaySession`, `PhoneUiAccessibilityService.snapshot` and `PhoneUiTaskExecutor` already provide the display, the tree and the refs, with different types. |
| Compose UI | `app/src/main/java/com/wangzan101/mika/ui/` | Deliberately out of scope: our phone-UI screens are ours; porting Mika's would be a rewrite, not a port. |
| `phone_sms_login` | `core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneSmsLogin.kt`, `app/src/main/java/com/wangzan101/mika/cap/phone/sms/` | Needs a surface we do not have: an authorized local SMS service and stored account profiles. Our notice filter drops authentication codes rather than reading them. |
| `phone_wait` | `PhoneAdvancedTools.kt` (`PhoneWait`) | Mostly built: `PHONE_UI_WAIT` has `change`, `settle`, `appear` and `disappear`. The text conditions poll snapshots at the change/settle cadence (150 ms) up to the call's `timeoutMs`, because this slice has no accessibility event stream to wake on. `activity` is not ported: a snapshot carries no activity class name, so a condition on one could not be observed rather than being faked. |
| `phone_event` | `PhoneAdvancedTools.kt` (`PhoneEventTool`) | Needs a surface we do not have: an accessibility event listener scoped to one call. Our service takes snapshots on demand and exposes no event stream. |
| `phone_extract` | `PhoneAdvancedTools.kt` (`PhoneExtract`) | Not built: list rows grouped by scrollable parent, form fields with labels and parent context. Our element list is flat. |
| `phone_dialog` | `PhoneAdvancedTools.kt` (`PhoneDialog`) | Not built: top-dialog inspection and click-through. Our snapshot has no window or dialog layering. |
| `phone_gesture` | `PhoneAdvancedTools.kt` (`PhoneGesture`) | Needs a surface we do not have: multi-path and two-finger injection. The shell helper injects one stroke. |
| `phone_system_command` | `PhoneAdvancedTools.kt` (`PhoneCommand`) | Deliberately out of scope: shell-UID command execution. The helper exists but no tool exposes a general command. |
| `phone_set_wheel` | `core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/SetWheel.kt`, `WheelMath.kt` | Not built: wheel detection and stepping. Our tree carries no `wheel` flag. |
| Capsule and overlay | `app/src/main/java/com/wangzan101/mika/capsule/` | Needs a surface we do not have: a `SYSTEM_ALERT_WINDOW` overlay. Our manifest declares no overlay permission. |
| `ViewUserScreen` | `core/src/main/kotlin/com/wangzan101/mika/core/general/ViewUserScreen.kt` | Needs a surface we do not have: a user-screen attachment model and the screenshot store behind it. |
| `ViewPastScreens` | `core/src/main/kotlin/com/wangzan101/mika/core/general/ViewPastScreens.kt` | Same as above, for earlier screens. |
| `teach` | `core/src/main/kotlin/com/wangzan101/mika/core/teach/Teach.kt`, `app/src/main/java/com/wangzan101/mika/ui/TeachScreen.kt` | Deliberately out of scope: a teach session that authors a skill from a run. |
| `settings_list` / `settings_set` | `core/src/main/kotlin/com/wangzan101/mika/core/settings/SelfConfig.kt`, `app/src/main/java/com/wangzan101/mika/settings/SelfConfigImpl.kt` | Deliberately out of scope: a bot changing its own settings, including model and key. |
| On-device Linux sandbox | `core/src/main/kotlin/com/wangzan101/mika/core/cap/sandbox/`, `app/src/main/java/com/wangzan101/mika/sandbox/` | Deliberately out of scope: an Alpine rootfs unpacked on the phone, arm64 only. Our computing story is the server's VM and containers. |
| `phone_list_elements` | `core/src/main/kotlin/com/wangzan101/mika/core/uistate/tools/ReadTools.kt` (`ListElements`) | Not built, by choice: `PHONE_UI_OBSERVE` is the same read. A second name for one snapshot would only enlarge the tool surface. |
| `phone_query`'s tree and parentage output | `PhoneAutomationTools.kt` (`PhoneQuery`) | Partly built: our query returns flat elements with refs, bounds and labels, not parent labels or tree position. Parentage needs the tree grouping `phone_extract` would need. |
| Vision locator | `core/src/main/kotlin/com/wangzan101/mika/core/vision/`, `core/src/main/kotlin/com/wangzan101/mika/core/uistate/tools/VisionTools.kt` | Needs a surface we do not have: a vision model routed to the phone to find a control by sight. Our screenshot goes to the bot's own model, which may or may not see images. |
| Mika's eval suite | `eval/tasks/` (128 task files) | Not ported: those are real-device scenarios for Mika's app and accounts. Our evals are in `evals/` and are ours. |

## Verification

The TypeScript phone subset — 26 files, 502 tests, all passing:

```sh
node_modules/.bin/vitest run \
  server/phones/access.test.ts server/phones/confirm.test.ts \
  server/phones/fixture.test.ts server/phones/host-revocation.test.ts \
  server/phones/host.test.ts server/phones/jobs.test.ts \
  server/phones/owner.test.ts server/phones/registry.test.ts \
  server/phones/rpc.test.ts server/phones/sends.test.ts \
  server/phones/steer.test.ts server/phones/tools.test.ts \
  shared/irreversible.test.ts shared/route-replay.test.ts \
  shared/untrusted.test.ts shared/sensitive.test.ts \
  shared/verify-grounding.test.ts \
  server/phone-guards.test.ts server/phone-notices.test.ts \
  server/intent-gate.test.ts server/phone-risk.test.ts \
  server/phone-routes.test.ts server/answer-verify.test.ts \
  server/phones/summary.test.ts \
  shared/phone-apps.test.ts server/chat-notices.test.ts
```

Per file: `access` 10, `confirm` 27, `fixture` 6, `host-revocation` 24,
`host` 27, `jobs` 18, `owner` 12, `registry` 13, `rpc` 16, `sends` 2,
`steer` 10, `tools` 19, `irreversible` 26, `route-replay` 45, `untrusted` 6,
`sensitive` 11, `verify-grounding` 38, `phone-guards` 16, `phone-notices` 54,
`intent-gate` 23, `phone-risk` 25, `phone-routes` 23, `answer-verify` 30,
`summary` 3, `phone-apps` 6, `chat-notices` 12.

The Android unit tests — 36 classes, 398 tests, all passing:

```sh
cd android && ./gradlew :app:testDebugUnitTest \
  --tests "com.lunabot.companion.phoneui.*" \
  --tests "com.lunabot.companion.wechat.*" --offline
```

That covers the 26 classes in
`android/app/src/test/kotlin/com/openmausbot/companion/phoneui/`, the 6 in
its `shell/` subdirectory and the 4 in `wechat/`. The counts that matter for
this batch:
`PhoneUiRunTest` 16, `PhoneUiCollectTest` 13, `PhoneUiFindTest` 17,
`PhoneUiWaitTest` 10,
`PhoneUiPacingTest` 22, `PhoneUiSelfCheckTest` 12, `PhoneUiSelfRepairTest` 17,
`PhoneUiAccessibilityRepairTest` 16, `PhoneUiRepairLoopTest` 11,
`PhoneUiProbesTest` 35, `PhoneUiProbesProbeTest` 16,
`PhoneUiProbesPackagesTest` 4, `PhoneUiSystemActionsTest` 8,
`PhoneUiAfterTaskTest` 9, `PhoneUiSecureSettingTest` 9, `PhoneUiGrantTest` 8,
`PhoneUiUnlockTest` 15, `UnlockCredentialStoreTest` 11,
`UnlockCredentialTest` 4, `PhoneUiShellUnlockGateTest` 3,
`PhoneUiUnlockTransactionsTest` 3, `WechatRuntimeTest` 22, `WechatApiTest` 21,
`WechatQrTest` 7, `WechatStoreTest` 7.

The job catalogue — 16 tests:

```sh
cd android && ./gradlew :core:test \
  --tests "com.lunabot.companion.core.PhoneJobsTest" --offline
```

The locale check — 16 languages, 10552 English strings:

```sh
pnpm i18n:check
```

The ratchets — 3 files, 4 tests, all passing:

```sh
node_modules/.bin/vitest run scripts/testing/file-size-ratchet.test.ts
node_modules/.bin/vitest run scripts/testing/index-route-ratchet.test.ts
node_modules/.bin/vitest run scripts/testing/tighten-ratchets.test.ts
```

Markdown is not counted by the file-size ratchet, so this document cannot break
it; running it confirms nothing else moved.

Three e2e suites fail on this machine: `server/phones.e2e.test.ts` (9 tests),
`server/phones-member-routine.e2e.test.ts` (3) and
`server/default-bot.e2e.test.ts` (2). All three wait for
`fixture.fixtureDumpPath`, the fake Claude engine's dump, while the configured
instance is the pi agent (`server/instance-fleets.ts`), whose fixture writes
`FAKE_PI_DUMP` and never touches `FAKE_CLAUDE_DUMP`. They fail inside that wait,
before any assertion about phone tools. `server/default-bot.e2e.test.ts` is not
touched by this work and fails identically, so the cause is that harness
mismatch, not the tool list: `server/phones/rpc.test.ts` asserts
`toolListing()` against `PHONE_TOOL_NAMES.length` and passes.

Five unit tests also fail on this machine, none of them in a file this work
touched: `scripts/testing/verification-docs.test.ts` reads
`enterprise/server/workspace-access.ts`, and this checkout has no `enterprise/`;
`scripts/packaged-native-modules.test.mjs` misses a `NOTICE` in its temporary
package; `scripts/testing/duration-sequencer.test.ts` (2 tests) runs a shard
weights file that names a test this checkout does not have;
`server/service-cli.test.ts` expects the installed `Luna Bot.app` plist; and
`server/testing/worker-port.test.ts` scans the same absent `enterprise/`.

## Deliberate divergences

| Area | Mika | Us | Why |
| --- | --- | --- | --- |
| English irreversible words | A label starting with `send`, `delete`, `pay`, … counts | A label must equal an entry | Phones here are often in English, and prefix matching turns "Send message to Alice" and "Payment history" into actions. Whole-label equality is also what keeps statuses out. |
| `PHONE_UI_RUN` with a classified step | Each sub-action goes back through `ActionExecutor.ran` (`action/ActionExecutor.kt`), so the batch's outward step is confirmed on its own | The whole run is refused | Our run is one job and one card for the chain, so an irreversible step inside it would ride a card the person approved for something else. Refusing the batch makes the bot run the other steps and then that one step alone, where the card names it. |
| Pacing at the fastest level | Gestures stay human at every level | `FAST` returns `GesturePace.Instant` | `FAST` is the default and has to stay byte-for-byte the old touch until someone opts in. A caller that wants Mika's rule asks for `GesturePace.human` explicitly. |
| Self-check status | Per check: `Pass`, `Partial`, `Fail`, `Skipped`, and `Partial` counts as passed for dependency purposes | Per check: `Pass`, `Fail`, `Skipped`; a partial result is a `Pass` whose detail carries the caveat; the run's verdict adds `Incomplete` when anything was skipped | Three per-check statuses keep the dependency rule simple (only `Pass` lets a dependent check run). A skip is not a failure and must not read as a pass, so the run reports `Incomplete` instead of a fourth per-check status. |
| `phone_collect` page merge | Appends pages scrolling down and prepends them scrolling up, so `direction` also decides reading order | Merges pages through a line-level dedup in reading order, so `direction` only picks the scroll | Our band keeps only lines wholly inside it, so a scroll never yields a partial line that needs re-ordering; one dedup rule covers both directions and a repeated line cannot appear twice. |
| `phone_collect` / `phone_scroll` direction words | Content direction on both, and `phone_swipe` names the finger | Content direction on `PHONE_UI_COLLECT` and `PHONE_UI_SCROLL`, finger direction on `PHONE_UI_SWIPE` | Same split Mika documents, stated in each schema so a bot cannot carry one tool's meaning to the other. |
| `PHONE_UI_AFTER_TASK` | Closes whatever is playing when the task ends unless told to keep it | Keeping is unconditional; only `close` is a choice | This app has no audio-session surface, so there is nothing to detect and no reason to default to closing. |
| `phone_find` | `PhoneFind` scrolls by `amount: 3` per call and needs three identical readings to call a screen unchanged | `PHONE_UI_FIND` scrolls one step per iteration, and two identical readings stop the loop | `PHONE_UI_SCROLL` takes one step, so `maxScrolls` is the budget in steps; our scroll already waits for the screen to change, so one equal comparison is a real answer rather than a scroll that may not have landed. |
| `phone_find` on an unreadable screen | Reads a protected flag and a readable-window verdict from the snapshot | A null snapshot is `read_failed`; an empty tree or an unreadable package is `screen_needs_review` | Our snapshot carries no protection flag. An empty tree is the shape an unreadable screen takes here, and the loop never scrolls a screen it cannot see. |
| `phone_wait` conditions | `appear`, `disappear`, `activity` and `stable`, each woken by the accessibility event stream and re-checked on the screen | `appear` and `disappear` poll snapshots every 150 ms up to `timeoutMs`; `activity` is not offered | Our service takes snapshots on demand and exposes no event stream, so the conditions are ported without the plumbing that woke Mika. `activity` needs an activity class name the snapshot does not carry, so it could only be faked. |
| Route replay and editable text | Stores an element's text and hint | Never names an editable text by its text | Our observe reports a field's `text` as what was typed into it and carries no separate hint flag, so storing it would persist the person's words into the next run. Role, resource id, bounds and ordinal identify the field instead. |
| Wireless-debugging grant | Mika's manifest declares `WRITE_SECURE_SETTINGS`, and its shell grants it whenever it can; auto-on then runs unconditionally | Off by default: a Settings switch asks for the grant, and the helper grants only that one permission, to the caller's own package | `WRITE_SECURE_SETTINGS` is not scoped to `adb_wifi_enabled`: an app holding it can write any secure or global setting. We already keep settings writes narrow (two allow-listed keys), so handing the app the broad permission has to be a decision the person makes, not a side effect of enabling phone control. |
| Grounding relative days and arithmetic | Resolves 今天/明天/周二 against the run clock and accepts an expression's result and 约/≈ rounding | Every such value must appear literally in the evidence | A date dependency and an expression evaluator are two more things to get wrong in a check whose whole value is being cheap and unfalsifiable. A bot that cannot show the number on screen should say it could not verify, not compute a plausible one. |
| Verifier timeout | Re-asks once with trimmed evidence and scales the budget with evidence size | One flat 60 s attempt, then `cannot_verify` | The retry doubles the cost of the one check that must never delay a reply. A timeout is a real answer: the evidence was too large or the model was slow, and the person still got the reply. |
| Steering a phone wait | Cancels the waiting coroutine with `select` | Races the promise and leaves the job running | A phone job cannot be stopped without telling the phone to stop, and a half-run screen session is worse than an unread answer. Nothing already done is undone; only the answer is dropped. |
| Route replacement | Replaces every route with the same template | Replaces only a copy with the same fingerprint | A different working path for the same sentence is a real alternative; replacing it would throw away the only route that worked on a different screen. `needsDecision` can ask instead. |
| API-key shapes | Mika's own four shapes | Delegated to `redactSecretsInText`, which knows ~20 provider shapes and PEM blocks | One definition of what a credential looks like, shared with the field-level skip and every other write path. Two lists would drift. |
| `other` irreversible kinds | Graded by payment context | Same, but a kind outside pay/order/delete/send is `unknown` until a payment context appears | `unknown` is the honest grade: `shared/irreversible.ts` has no other kinds today, so anything else means a caller passed something the gate does not classify. |
| WeChat host | Every call goes to the `baseurl` the bind response returned | Pinned to `ilinkai.weixin.qq.com`; `baseurl` is parsed and discarded | That field is chosen by the login response, and what it redirects is a bearer token for the whole bot channel. |
| Device unlock | `wm dismiss-keyguard` plus targeted injection | Targeted injection only, no command endpoint | The helper has no shell command surface by design; `reveal` then `enter` covers the same path without one. |
