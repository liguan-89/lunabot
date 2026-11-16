# Luna Bot Cloud

The self-hosted account, licence and companion service for Luna Bot. One Node
process answers both APIs the clients use:

- **Cloud Admin** (`/api/cloud/...`): desktop sign-in, licence entitlement,
  devices, plans, cloud list, consent.
- **Companion control plane** (`/healthz`, `/api/auth/...`, `/v1/...`): the
  account used by the desktop's **Phone and devices** sheet, installations,
  installation credentials and relay grants.

It also serves the docs, feedback form, download page and the Android update
manifest, plus the desktop installers and electron-updater feeds under
`/desktop/`. The private source repository is never linked from the product.

## Current scope

Implemented and covered by `test/flow.test.js`:

- device-code sign-in with a browser approval page (`/cloud/desktop`);
- eight-digit email-code sign-in for the desktop and the control plane;
- `omc_` Cloud sessions with a `pro` licence entitlement;
- installation registration, credential rotation and revocation;
- `409 relay_capable` for managed tunnels, so phones use the relay;
- Ed25519 relay grants (`relay1.dexai.vip` or `cloud.dexai.vip`);
- consent records, update manifest and APK download;
- self-hosted plan activation pages (`/cloud`, `/pro/buy`);
- hosted Cloud desktops: one `dexbot-cloud-home` container and volume per
  Cloud, a `c-<id>.cloud.dexai.vip` origin, health-checked provisioning,
  start/stop, and signed pairing codes from the Cloud itself.

Not implemented yet, and deliberately answered with a refusal rather than a
fake success:

- real payments — `/pro/buy` and adding a Cloud activate the self-hosted plan
  without taking money;
- team and organisation billing;
- per-Cloud network isolation and real disk resizing (the disk is reported,
  not grown);
- managed Cloudflare tunnels. The control plane says `relay_capable` and the
  phone uses the relay instead.

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
  src/docker.js      Docker Engine API over the Unix socket
  src/provisioner.js Cloud container/volume lifecycle, health, pairing
  src/router.js      Host-based TCP router for c-<id>.cloud.dexai.vip
  src/main.js        process entry
  compose.yaml       one container, loopback ports 8791/8792
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

The two `/v1` paths belong to the phone relay. Everything else is Luna Bot Cloud.

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
| `DEXCLOUD_APK_PATH` / `DEXCLOUD_UPDATE_PATH` | Android package and update manifest on the volume |
| `DEXCLOUD_DESKTOP_DIR` | desktop installers and `latest*.yml` feeds, served at `/desktop/<file>` |
| `DEXCLOUD_DOCKER_SOCKET` | Docker Engine socket, default `/var/run/docker.sock` |
| `DEXCLOUD_CLOUD_IMAGE` | image for each Cloud, default `dexbot-cloud-home:local` |
| `DEXCLOUD_CLOUD_NETWORK` | shared Docker network, default `dexcloud` |
| `DEXCLOUD_CLOUD_HOST_SUFFIX` | per-Cloud hostname suffix, default `cloud.dexai.vip` |
| `DEXCLOUD_CLOUD_MEMORY_MB` | memory limit per Cloud, default 1536 |
| `DEXCLOUD_CLOUD_DISK_GB` / `_MAX_DISK_GB` | reported disk size and its cap |
| `DEXCLOUD_CLOUD_MAX_PER_ACCOUNT` | how many Clouds one account may own, default 1 |
| `DEXCLOUD_ROUTER_PORT` | Host router port behind Caddy, default 8792 |

Production needs SMTP or Resend. `DEXCLOUD_DEV_CODES=1` is a bootstrap mode:
anyone who can read the container log can sign in.

## Hosted Cloud desktops

Each Cloud is one `dexbot-cloud-home` container with a `dexcloud-<id>-data`
volume on the shared `dexcloud` Docker network. The container's own edge Caddy
listens on `:8080`; no host port is published. `src/router.js` reads the Host
header, looks the Cloud up in SQLite, and proxies the connection to
`dexcloud-<id>:8080`, so WebSockets and the event stream pass through.

DNS needs one wildcard record:

```text
*.cloud.dexai.vip  A  186.241.77.89
```

Caddy terminates TLS per Cloud host on demand:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:8791/internal/tls-ask
	}
}

*.cloud.dexai.vip {
	encode zstd gzip
	header -Server
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8792
}
```

The ask endpoint only returns 200 for a hostname in the `clouds` table, so an
unknown `*.cloud.dexai.vip` name never gets a certificate.

Build the image from the repository root:

```sh
docker buildx build --load --platform linux/amd64 \
  --target cloud-home -t dexbot-cloud-home:local .
```

The container starts as root to take ownership of `/data`, then runs the server
and its edge as `maus`. The service container needs the Docker socket and the
daemon's group:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
group_add: ["121"]   # stat -c %g /var/run/docker.sock
```

A new Cloud is visible as `setting_up` with `setup.step` and `progress`, then
`ready` with `https://c-<id>.cloud.dexai.vip`. Pairing codes are minted by the
Cloud itself and signed by the Admin with the per-Cloud bootstrap secret.

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
