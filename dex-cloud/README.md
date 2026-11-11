# DEX Cloud

The self-hosted account, licence and companion service for DEX BOT. One Node
process answers both APIs the clients use:

- **Cloud Admin** (`/api/cloud/...`): desktop sign-in, licence entitlement,
  devices, plans, cloud list, consent.
- **Companion control plane** (`/healthz`, `/api/auth/...`, `/v1/...`): the
  account used by the desktop's **Phone and devices** sheet, installations,
  installation credentials and relay grants.

It also serves the download page, the Android update manifest and the APK.

## Current scope

Implemented and covered by `test/flow.test.js`:

- device-code sign-in with a browser approval page (`/cloud/desktop`);
- eight-digit email-code sign-in for the desktop and the control plane;
- `omc_` Cloud sessions with a `pro` licence entitlement;
- installation registration, credential rotation and revocation;
- `409 relay_capable` for managed tunnels, so phones use the relay;
- Ed25519 relay grants (`relay1.dexai.vip` or `cloud.dexai.vip`);
- consent records, update manifest and APK download;
- self-hosted plan activation pages (`/cloud`, `/pro/buy`).

Not implemented yet, and deliberately answered with a refusal rather than a
fake success:

- hosted Cloud desktop provisioning (a `clouds` row with a real origin);
- team and organisation billing;
- a payment provider — `/pro/buy` activates a plan without taking money;
- managed Cloudflare tunnels. The control plane says `relay_capable` and the
  phone uses the relay instead.

The desktop and the phone therefore work today for account sign-in, licence,
LAN/Tailscale pairing and relay pairing. A paid hosted desktop is the next
phase.

## Layout

```text
dex-cloud/
  src/config.js      env parsing and origin validation
  src/store.js       SQLite schema and queries
  src/crypto.js      token shapes, OTP HMAC, Ed25519 relay signing
  src/accounts.js    accounts, sessions, entitlement
  src/helpers.js     auth, rate limits, OTP send/verify
  src/admin.js       /api/cloud/* routes
  src/control.js     /healthz and /v1/* routes
  src/pages.js       approval, plans, checkout and download pages
  src/server.js      router, static files, error handling
  src/main.js        process entry
  compose.yaml       one container, loopback port 8791
```

## Deploy on the VPS

The service runs as a container on `186.241.77.89` and Caddy terminates TLS for
`cloud.dexai.vip`.

```sh
rsync -a --delete --exclude data --exclude .env dex-cloud/ root@host:/opt/dex-cloud/
ssh root@host
cd /opt/dex-cloud
cp .env.example .env        # fill the secrets
mkdir -p data/downloads
chown -R 1000:1000 data
docker compose up -d --build
curl -s http://127.0.0.1:8791/healthz
```

Caddy:

```caddyfile
cloud.dexai.vip {
	encode zstd gzip
	header -Server
	handle /v1/host* {
		reverse_proxy 127.0.0.1:18080
	}
	handle /v1/phone* {
		reverse_proxy 127.0.0.1:18080
	}
	handle {
		reverse_proxy 127.0.0.1:8791
	}
}
```

The two `/v1` paths belong to the phone relay. Everything else is DEX Cloud.

## Environment

| Variable | Meaning |
| --- | --- |
| `DEXCLOUD_ORIGIN` | must be a bare `https://` origin; the client pins it |
| `DEXCLOUD_HOST` / `DEXCLOUD_PORT` | container listen address (`0.0.0.0:8791`) |
| `DEXCLOUD_DB` | SQLite file (`/data/dex-cloud.db`) |
| `DEXCLOUD_RELAY_TOKEN_SEED` | base64url 32-byte Ed25519 seed; also peppers OTP hashes |
| `DEXCLOUD_RELAY_TOKEN_KID` | key id the relay expects (`k1`) |
| `DEXCLOUD_RELAY_NODES` | comma list, `cloud.dexai.vip` and/or `relay1.dexai.vip` |
| `DEXCLOUD_EMAIL_FROM` | From header |
| `DEXCLOUD_SMTP_URL` | `smtp://user:pass@host:port` or `smtps://...` |
| `DEXCLOUD_RESEND_API_KEY` | Resend HTTP API instead of SMTP |
| `DEXCLOUD_DEV_CODES` | `1` prints codes to the log; development only |
| `DEXCLOUD_SIGNUP_OPEN` | `0` refuses new addresses |
| `DEXCLOUD_PLAN_MODE` | `pro` (default) grants a long-lived self-hosted licence; `free` does not |
| `DEXCLOUD_LATEST_VERSION` | version written into `/update.json` |

Production needs SMTP or Resend. `DEXCLOUD_DEV_CODES=1` is a bootstrap mode:
anyone who can read the container log can sign in.

## Relay keys

Generate once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put it in `DEXCLOUD_RELAY_TOKEN_SEED`. The relay only needs the public key:

```sh
docker compose -f /opt/dex-cloud/compose.yaml exec -T cloud node -e "
const c=require('crypto');
const seed=Buffer.from(process.env.DEXCLOUD_RELAY_TOKEN_SEED,'base64url');
const key=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
console.log(JSON.stringify({k1:c.createPublicKey(key).export({format:'jwk'}).x}));"
```

That JSON is `RELAY_TOKEN_KEYS` in the relay's environment. Rotate by adding a
second entry (`k2`) to both sides, shipping it, then removing `k1`.

## Data and backups

Everything lives in `data/`:

- `dex-cloud.db` and its WAL files: accounts, sessions, installations, plans;
- `downloads/dexbot.apk`: the APK `/download/dexbot.apk` serves;
- `downloads/update.json`: optional override for the generated manifest;
- `downloads/landing.html`: optional landing page.

Back up `data/` with the container stopped, or copy the SQLite database with
`sqlite3 .backup` while it runs.

## Security notes

- Session and installation credentials are stored only as SHA-256 hashes.
- OTP codes are stored as HMAC-SHA256 with the relay seed as the pepper; a
  wrong code increments a per-attempt counter and five failures expire it.
- Device and email attempts expire; the sweeper also drops old rows hourly.
- Request bodies are capped at 64 KiB; every response is `no-store`.
- The origin is pinned; `cloudOrigin` in the desktop rejects any other address.
- Relay grants are Ed25519-signed, scoped to one installation and 12 hours.
- Caddy is the only public listener; the container binds `127.0.0.1:8791`.
