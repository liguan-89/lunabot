# Mika gap analysis

## Why this exists

Mika ([wangzan101/Mika](https://github.com/wangzan101/Mika), Apache-2.0) is an
Android agent app: one APK that drives the phone it is installed on, in a
virtual display of its own, and ships its own decision model client, loop
guards, notification learning, experience replay and self-check. Luna Bot is a
TypeScript server with an Electron desktop app and a Kotlin Android companion:
the server runs turns, and the phone is a paired device the server sends jobs
to. We compared the two and ported the parts of Mika that fit that split.

This batch added nine phone tools, a second approval gate for irreversible
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

`PHONE_TOOL_NAMES` in `shared/phone-apps.ts` now holds 51 tools. The stale
build in `dist-server/shared/phone-apps.js` (gitignored output, older than this
change) lists 42; the difference is exactly the nine below. The input schemas
are in `server/phones/tools.ts`, the write sentences in
`server/phones/summary.ts` and `server/chat-notices.ts`, and the prompt text in
`server/phones/instructions.ts` (`PHONE_INSTRUCTIONS` and `PHONE_PROMPT` both
name the new tools).

| Tool | Capability | Read/write | What it adds |
| --- | --- | --- | --- |
| `PHONE_UI_COLLECT` | phoneUi | write | Reads several screens in one call, scrolling between them, and stops at the end of the list. |
| `PHONE_UI_RUN` | phoneUi | write | Runs up to 20 screen commands in one call and stops at the first failure. |
| `PHONE_UI_QUERY` | phoneUi | read | Narrows the current snapshot by text, view id or role, so a long screen costs one answer. |
| `PHONE_LIST_APPS` | phoneUi | read | Lists launcher apps with their real package names for `PHONE_UI_LAUNCH`. |
| `PHONE_SET_ALARM` | phoneUi | write | Sets an alarm through the Clock app's own intent, with `EXTRA_SKIP_UI` so no editor opens. |
| `PHONE_SET_TIMER` | phoneUi | write | Starts a countdown timer the same way. |
| `PHONE_OPEN_LINK` | phoneUi | write | Opens an http or https link on the controlled display, not the person's own screen. |
| `PHONE_SHARE_TEXT` | phoneUi | write | Puts text into another app's compose screen, which the person still sends. |
| `PHONE_UI_AFTER_TASK` | phoneUi | write | Chooses whether the app a task drove is kept or finished when the task ends. |

The Android build serves 46 of the 51: `android/core/src/main/kotlin/com/openmausbot/companion/core/PhoneJobs.kt`
has no `PhoneTool` entry for `PHONE_RESPOND_TO_INVITE`,
`PHONE_FIND_PLACES_NEARBY`, `PHONE_LIST_HOME`, `PHONE_SET_ACCESSORY` or
`PHONE_RUN_SCENE`, so those five answer `unsupported` from
`PhoneToolCatalog.capabilityOf`. None of the five is a phone-UI tool, so every
one of the nine new tools is served. That file also carries `PHONE_REPLY_SMS`,
which is the SMS relay's own reply job and is not in the server's tool list.
All nine are registered in the executor's `actionOf` map in
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

One gap to know about: `server/chat-notices.ts` has no
`chat.notice.phone.write.PHONE_UI_RUN` key, so the activity row for a run falls
back to `phoneWriteSummary`'s generic sentence built from `describeAction`,
"Ui run on <phone>". The other six new write tools (`PHONE_UI_COLLECT`,
`PHONE_SET_ALARM`, `PHONE_SET_TIMER`, `PHONE_OPEN_LINK`, `PHONE_SHARE_TEXT`,
`PHONE_UI_AFTER_TASK`) have their own sentence; `PHONE_UI_QUERY` and
`PHONE_LIST_APPS` are reads and post no activity row.

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

Nothing calls it yet: no server module imports `phone-notices.ts`. The phone's
own `PHONE_NOTIF_LIST` reads `PhoneNoticeStore`, a separate flat title/text
store, and never reaches this module.

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

Storage and execution are not built. There is no route codec, no file store, no
replayer, and nothing imports `route-replay.ts` outside its test.

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

## What is still missing

| Capability | Mika's files | Why not ported |
| --- | --- | --- |
| Storage glue | `core/.../adb/` identity types (`AdbIdentitySource`, `AdbKeyState`, `AdbKeyStore`, `WrappedKeyFile`), `replay/FileRouteStore.kt`, `replay/RouteStore.kt`, `proactive/NoticeJournal.kt`, `app/src/main/java/com/wangzan101/mika/record/RunStore.kt` | Not built here: our state lives server-side (the gates in `PhoneUiConfirms`, the phone registry) and the ADB key store stays app-side by design, as `third_party/mika/README.md` records. |
| Model client | `core/src/main/kotlin/com/wangzan101/mika/core/agent/ModelCaller.kt`, `ModelRouter.kt` | Not built: `server/decider/` already owns every model call we make, with keys, logging, relay and fail-open. A second client on the phone would duplicate it. |
| Android notification-format parsing | `core/src/main/kotlin/com/wangzan101/mika/core/proactive/NoticeShapes.kt` | Not built: our phone posts flat `title`/`text` through `PhoneNoticeStore`, which reads `EXTRA_TITLE`, `EXTRA_TEXT` and `EXTRA_BIG_TEXT` only. Splitting MessagingStyle conversations needs a phone-side parser we do not have. |
| Screen port and snapshot plumbing | `core/.../uistate/ScreenPort.kt`, `ScreenSession.kt`, `AppAccessScreenPort.kt` | Not built: `PhoneUiDisplaySession`, `PhoneUiAccessibilityService.snapshot` and `PhoneUiTaskExecutor` already provide the display, the tree and the refs, with different types. |
| Compose UI | `app/src/main/java/com/wangzan101/mika/ui/` | Deliberately out of scope: our phone-UI screens are ours; porting Mika's would be a rewrite, not a port. |
| `phone_sms_login` | `core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneSmsLogin.kt`, `app/src/main/java/com/wangzan101/mika/cap/phone/sms/` | Needs a surface we do not have: an authorized local SMS service and stored account profiles. Our notice filter drops authentication codes rather than reading them. |
| `phone_find` | `core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneAdvancedTools.kt` (`PhoneFind`) | Not built: scroll-until-found with per-screen checking. `PHONE_UI_COLLECT` reads forward and `PHONE_UI_QUERY` filters one screen; neither searches for a target across screens. |
| `phone_wait` | `PhoneAdvancedTools.kt` (`PhoneWait`) | Partly built: `PHONE_UI_WAIT` has `change` and `settle` only. Text-appear, text-disappear and activity conditions need the event stream below. |
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

The TypeScript phone subset — 16 files, 313 tests, all passing:

```sh
node_modules/.bin/vitest run \
  server/phones/access.test.ts server/phones/confirm.test.ts \
  server/phones/fixture.test.ts server/phones/host-revocation.test.ts \
  server/phones/host.test.ts server/phones/jobs.test.ts \
  server/phones/owner.test.ts server/phones/registry.test.ts \
  server/phones/rpc.test.ts server/phones/sends.test.ts \
  server/phones/tools.test.ts \
  shared/irreversible.test.ts shared/route-replay.test.ts \
  server/phone-guards.test.ts server/phone-notices.test.ts \
  server/intent-gate.test.ts
```

Per file: `access` 10, `confirm` 27, `fixture` 6, `host-revocation` 24,
`host` 15, `jobs` 18, `owner` 12, `registry` 13, `rpc` 16, `sends` 2, `tools` 6,
`irreversible` 26, `route-replay` 45, `phone-guards` 16, `phone-notices` 54,
`intent-gate` 23.

The Android unit tests — 25 classes, 278 tests, all passing:

```sh
cd android && ./gradlew :app:testDebugUnitTest \
  --tests "com.openmausbot.companion.phoneui.*" --offline
```

That covers the 20 classes in
`android/app/src/test/kotlin/com/openmausbot/companion/phoneui/` and the 5 in
its `shell/` subdirectory. The counts that matter for this batch:
`PhoneUiRunTest` 16, `PhoneUiCollectTest` 13, `PhoneUiPacingTest` 22,
`PhoneUiSelfCheckTest` 12, `PhoneUiSelfRepairTest` 17,
`PhoneUiAccessibilityRepairTest` 16, `PhoneUiRepairLoopTest` 11,
`PhoneUiProbesTest` 35, `PhoneUiProbesProbeTest` 16,
`PhoneUiProbesPackagesTest` 4, `PhoneUiSystemActionsTest` 8,
`PhoneUiAfterTaskTest` 9, `PhoneUiSecureSettingTest` 9, `PhoneUiGrantTest` 8.

The job catalogue — 16 tests:

```sh
cd android && ./gradlew :core:test \
  --tests "com.openmausbot.companion.core.PhoneJobsTest" --offline
```

The locale check — 16 languages, 10541 English strings:

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
| Route replay and editable text | Stores an element's text and hint | Never names an editable text by its text | Our observe reports a field's `text` as what was typed into it and carries no separate hint flag, so storing it would persist the person's words into the next run. Role, resource id, bounds and ordinal identify the field instead. |
| Wireless-debugging grant | Mika's manifest declares `WRITE_SECURE_SETTINGS`, and its shell grants it whenever it can; auto-on then runs unconditionally | Off by default: a Settings switch asks for the grant, and the helper grants only that one permission, to the caller's own package | `WRITE_SECURE_SETTINGS` is not scoped to `adb_wifi_enabled`: an app holding it can write any secure or global setting. We already keep settings writes narrow (two allow-listed keys), so handing the app the broad permission has to be a decision the person makes, not a side effect of enabling phone control. |
