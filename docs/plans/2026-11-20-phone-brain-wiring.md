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

Deliberately not in this batch: miss/success bookkeeping after a replay
(needs the turn-end outcome comparison — phase 1b), and a dedicated replay
job the phone could run while the server is unreachable (a real on-device
executor — separate work).

## Phase 2 — intent gate

`server/intent-gate.ts` (`assessIntent`, DISCUSS/READ/ACT at 0.85, 10 s
budget) is tested and dead. Wiring needs one product decision first: what
ACT means here — in Mika it gates whether the phone may be driven at all;
in our split the honest seat is before the first phone *write* call, where
a DISCUSS verdict declines the call cheaply. It is not a safety mechanism
(the outbound card is stricter), its value is cost: refusing to offer
screen-write tools when the person is only chatting. Deferred until that
decision is made; the module stays as is.

## Phase 3 — notification learning ingress

`server/phone-notices.ts` needs a phone → server push path that does not
exist: a new authenticated endpoint on `/api/phones/self/events` (sibling of
the sms/wechat `onEvent` path), per-owner retention, and a consent decision
broader than the `phoneData` reads already granted — the person must opt in
to the phone reading *every* notification, not just answering list queries.
Phone side: `PhoneNoticeStore` gains a posting hook on insert. Deferred;
needs the consent copy and the retention numbers decided first.

## Verification

Phase 1: new unit tests beside `server/phones/host.test.ts` for the injected
part (one match, ambiguous match, no recorder, no goal); `vitest run` the
phones directory; `oxlint` the touched files.
