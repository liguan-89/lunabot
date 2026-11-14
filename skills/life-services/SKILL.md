---
name: life-services
description: "Connect an on-demand data source when a task needs real-world lookups: China places, addresses and routes (Tencent Maps or Baidu Maps), or live flight status and schedules (VariFlight). Use when the person asks to find a place, resolve an address, plan a route, check a flight, or look something up and no connected source covers it."
---

# Life services data sources

When a task needs real-world lookups — a place, an address, a route, a flight's status — the answer may live behind a
data source that isn't connected yet. Check what the bot already has with `mcp_server` action `list`; if nothing covers
the need, offer one of the official sources below and connect it the way it wants.

Rules that always apply:

- The person connects a source once in Apps, or agrees to you adding it in this conversation — never add one
  unilaterally.
- Never ask for a key in chat and never invent one. A key arrives through `request_credential` (delivery `ref`) or the
  person pastes it on the source's card in Apps.
- A `secret-ref:` value goes in a header, never into a message, a file, or a URL a person could copy.
- Once the server is connected and enabled, its tools arrive next turn — retry the lookup then instead of guessing.

## 腾讯地图 — places, addresses and routes in China

Official endpoint: `https://mcp.map.qq.com/sse` (transport `sse`). Coverage: POI/place search, address resolution and
route planning inside China.

Its developer key rides inside the address itself (`?key=`). A URL with a key in it is the person's to paste, so DO NOT
assemble the URL or request the key for a header. Tell the person the Apps panel has a **腾讯地图** card whose
"Get a key" button opens the Tencent Location console (lbs.qq.com); pasting it there stores it in the Vault and wires
the server for them.

## 百度地图 — places, addresses, routes and traffic in China

Official endpoint: `https://mcp.map.baidu.com/mcp` (transport `http`). Coverage: geocoding, place search, route
planning, weather and traffic inside China — the alternative when the person prefers Baidu's data over Tencent's.

Same rule as Tencent Maps: its server-side AK rides inside the address (`?ak=`), so DO NOT assemble the URL or request
the key. The Apps panel has a **百度地图** card whose "Get a key" button opens the Baidu Maps open platform
(lbsyun.baidu.com); the AK must be the server-side type with the MCP service enabled for it.

## 飞常准 (VariFlight) — live flight status and schedules

Official endpoint: `https://c-gw.variflight.com/chat_message/mcp/api/legacy` (transport `http`). Coverage: real-time
flight status, schedules and delays.

Its user key (`sk-user-…`) goes in a normal header, so you can wire it up:

1. `request_credential` with `delivery: "ref"`, `label` like "飞常准 MCP key" and a `reason` that says flights come
   from the VariFlight MCP platform, then end your turn and wait.
2. On the secret's return, `mcp_server` action `add` with `name: "variflight"`, `type: "http"`, that url, and
   `headers` `{ "Authorization": "Bearer <secretRef>" }`.
3. Below Full access the add applies at once for a public url; a refused or failed probe is reported honestly —
   never claim it connected.

If the person prefers to do it themselves, the Apps panel has a **飞常准** card with a key link — saying that once is
enough.
