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

`server/phone-notices.ts` needs a phone → server push path that does not
exist: a new authenticated endpoint on `/api/phones/self/events` (sibling of
the sms/wechat `onEvent` path), per-owner retention, and a consent decision
broader than the `phoneData` reads already granted — the person must opt in
to the phone reading *every* notification, not just answering list queries.
Phone side: `PhoneNoticeStore` gains a posting hook on insert. Deferred;
needs the consent copy and the retention numbers decided first.

## Verification

Phase 1/1b: unit tests beside `server/phone-routes.test.ts` for `settle`
(success clears, same-step misses retire, elsewhere resets, `used` touches
only) and beside `server/phones/host.test.ts` for the end-turn settle
(success, unchanged-call miss, refused-only and stopped settle nothing);
`vitest run` the phones directory; `oxlint` the touched files.
