# TK1688 market E2E

`scripts/market-e2e.mjs` walks the whole client contract with the real
`electron/market-client.mjs`: OAuth sign-in, plans, checkout, subscription,
key reveal, then the issued key against `/v1/models` and one chat turn. It
prints every step and ends with `E2E OK`; a failure exits non-zero.

It is a development tool. Run it against `scripts/mock-market-api.mjs` or a
local/staging tk1688; never against production without the station owner's
explicit approval.

Verified 2026-11-13 against a fresh local backend: real `/oauth/authorize`
shell (refresh cookie → access token → JSON consent), 12 seeded SKUs, balance
checkout, subscription, key reveal, `/v1/models`, and one chat turn through a
loopback fake upstream — `E2E OK`. The shell path and the older form-based
authorize path are both handled.

## Mock

```sh
node scripts/mock-market-api.mjs           # terminal 1
MARKET_E2E_BASE=http://127.0.0.1:4010 \
MARKET_E2E_API=http://127.0.0.1:4010 \
MARKET_E2E_MOCK=1 \
MARKET_E2E_PLAN=t20-m \
MARKET_E2E_PAYMENT=epay \
node scripts/market-e2e.mjs               # terminal 2
```

The mock auto-approves OAuth, marks the checkout paid when the pay URL is
opened, and answers `/v1/models` plus a tiny SSE/non-SSE chat completion.

## Real local backend

Prerequisites:

1. The OAuth client `dexbot-desktop` exists (see the tk1688 backend checklist):
   redirect `http://127.0.0.1/oauth/callback`, the four `market.*` scopes, enabled.
2. The 18 market SKUs are seeded (`POST /api/supplier_admin/plans/seed` with an
   admin session, or the admin console); the chosen plan is enabled and has a
   model whitelist.
3. The test account has enough wallet quota for `balance`, or a working epay
   checkout for `epay`.
4. A signed-in browser session cookie for that account. Paste the raw `Cookie`
   header value into `MARKET_E2E_COOKIE`; normally that is
   `new_api_refresh=…; new_api_has_session=1` from the login response.
5. For the chat turn: a channel whose models cover the plan whitelist. A
   loopback fake upstream also needs `fetch_setting.allow_private_ip=true` and
   its port in `allowed_ports` (local development only).

```sh
MARKET_E2E_BASE=http://127.0.0.1:3005 \
MARKET_E2E_API=http://127.0.0.1:3005 \
MARKET_E2E_COOKIE='session=...' \
MARKET_E2E_PLAN=t20-m \
MARKET_E2E_PAYMENT=balance \
node scripts/market-e2e.mjs
```

For `epay`, the script prints the checkout URL and waits for payment; pay in the
browser that holds the session cookie. Set `MARKET_E2E_AUTOPAY=1` only with the
mock (fetching the mock's pay URL settles it; a real epay page needs a human).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARKET_E2E_BASE` | required | Web origin, e.g. `http://127.0.0.1:4010` or `https://staging.tk1688.com` |
| `MARKET_E2E_API` | `MARKET_E2E_BASE` | API origin; differs only if the API has its own host |
| `MARKET_E2E_CLIENT_ID` | `dexbot-desktop` | Registered OAuth client |
| `MARKET_E2E_COOKIE` | empty | Raw `Cookie` header for authorize/consent; mock needs none |
| `MARKET_E2E_PLAN` | `t20-m` | SKU slug; falls back to the first returned plan |
| `MARKET_E2E_PAYMENT` | `balance` | `balance` or `epay` |
| `MARKET_E2E_MODEL` | first `/v1/models` id | Model used for the chat turn |
| `MARKET_E2E_MOCK` | `0` | `1` enables the mock's pay-on-open and auto-pay |
| `MARKET_E2E_TIMEOUT_MS` | `600000` | Checkout wait limit |

## What it does not cover

- Installing the key as an engine: that is the Electron main path
  (`electron/market-ipc.mjs` → `POST /api/instances/openai-compat`), covered by
  `electron/market-ipc.node-test.mjs`.
- The Settings card rendering: covered by `src/components/MarketSubscriptionCard.test.ts`.
- Renewal, cancel and refunds: phase two.