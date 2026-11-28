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
- Ed25519 relay grants (`cloud.dexai.vip` by default; `relayN.dexai.vip` only with its own site block);
- consent records, update manifest and APK download;
- self-hosted plan activation pages (`/cloud`, `/pro/buy`);
- hosted Cloud desktops: one `lunabot-cloud-home` container and volume per
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
| `LUNABOT_CLOUD_ORIGIN` | must be a bare `https://` origin; the client pins it |
| `LUNABOT_CLOUD_HOST` / `LUNABOT_CLOUD_PORT` | container listen address (`0.0.0.0:8791`) |
| `LUNABOT_CLOUD_DB` | SQLite file (`/data/dex-cloud.db`) |
| `LUNABOT_CLOUD_RELAY_TOKEN_SEED` | base64url 32-byte Ed25519 seed; also peppers OTP hashes |
| `LUNABOT_CLOUD_RELAY_TOKEN_KID` | key id the relay expects (`k1`) |
| `LUNABOT_CLOUD_RELAY_NODES` | comma list; default `cloud.dexai.vip`, which serves the relay routes itself. A `relayN.dexai.vip` name needs its own Caddy site block first, or the TLS handshake fails |
| `LUNABOT_CLOUD_EMAIL_FROM` | From header |
| `LUNABOT_CLOUD_SMTP_URL` | `smtp://user:pass@host:port` or `smtps://...` |
| `LUNABOT_CLOUD_RESEND_API_KEY` | Resend HTTP API instead of SMTP |
| `LUNABOT_CLOUD_DEV_CODES` | `1` prints codes to the log; development only |
| `LUNABOT_CLOUD_SIGNUP_OPEN` | `0` refuses new addresses |
| `LUNABOT_CLOUD_PLAN_MODE` | `pro` (default) grants a long-lived self-hosted licence; `free` does not |
| `LUNABOT_CLOUD_LATEST_VERSION` | version written into `/update.json` |
| `LUNABOT_CLOUD_APK_PATH` / `LUNABOT_CLOUD_UPDATE_PATH` | Android package and update manifest on the volume |
| `LUNABOT_CLOUD_DESKTOP_DIR` | desktop installers and `latest*.yml` feeds, served at `/desktop/<file>` |
| `LUNABOT_CLOUD_DOCKER_SOCKET` | Docker Engine socket, default `/var/run/docker.sock` |
| `LUNABOT_CLOUD_CLOUD_IMAGE` | image for each Cloud, default `lunabot-cloud-home:local` |
| `LUNABOT_CLOUD_CLOUD_NETWORK` | shared Docker network, default `dexcloud` |
| `LUNABOT_CLOUD_CLOUD_HOST_SUFFIX` | per-Cloud hostname suffix, default `cloud.dexai.vip` |
| `LUNABOT_CLOUD_CLOUD_MEMORY_MB` | memory limit per Cloud, default 1536 |
| `LUNABOT_CLOUD_CLOUD_DISK_GB` / `_MAX_DISK_GB` | reported disk size and its cap |
| `LUNABOT_CLOUD_CLOUD_MAX_PER_ACCOUNT` | how many Clouds one account may own, default 1 |
| `LUNABOT_CLOUD_ROUTER_PORT` | Host router port behind Caddy, default 8792 |
| `LUNABOT_CLOUD_DESKTOP_HOST` / `_SSH_PORT` | optional managed desktop host and SSH port |
| `LUNABOT_CLOUD_DESKTOP_PROVISION_USER` | restricted user on the desktop host, default `dexcloud-desktop` |
| `LUNABOT_CLOUD_DESKTOP_PROVISION_KEY` | provisioning private key, preferably `file:/data/desktop-provision-key` |
| `LUNABOT_CLOUD_DESKTOP_HOST_PUBLIC_KEY` | desktop host ed25519 public key, key type and body only (no host or comment) |
| `LUNABOT_CLOUD_DESKTOP_ALIAS` | SSH alias written inside Cloud homes, default `dexcloud-desktop` |

Production needs SMTP or Resend. `LUNABOT_CLOUD_DEV_CODES=1` is a bootstrap mode:
anyone who can read the container log can sign in.

## Hosted Cloud desktops

Each Cloud is one `lunabot-cloud-home` container with a `dexcloud-<id>-data`
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
  --target cloud-home -t lunabot-cloud-home:local .
```

The container starts as root to take ownership of `/data`, then runs the server
and its edge as `lunabot`. The service container needs the Docker socket and the
daemon's group:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
group_add: ["121"]   # stat -c %g /var/run/docker.sock
```

A new Cloud is visible as `setting_up` with `setup.step` and `progress`, then
`ready` with `https://c-<id>.cloud.dexai.vip`. Pairing codes are minted by the
Cloud itself and signed by the Admin with the per-Cloud bootstrap secret.

## Managed desktop host

A managed desktop host is optional. It is a **dedicated** Ubuntu 22.04/24.04
x86_64 VPS; do not run the Cloud Admin, Cloud homes, or other tenants on it.
`desktop-host/install.sh` creates a fixed set of `dxd<N>` tenant users, each
with its own rootless Docker daemon under the official per-user systemd service.
The surrounding `user@<uid>` systemd unit carries the tenant CPU, memory and
task caps. The rootful Docker service is disabled even though the `docker-ce`
package is installed for the `dockerd` binary.

Cloud homes never receive host root or the host Docker socket. They receive a
per-Cloud ed25519 key for one tenant user. Authorized keys live in a root-owned
central directory outside tenant homes, so Docker access cannot replace them.
That key is forced through `dexcloud-docker-command`, which accepts only the
Docker-over-SSH stdio bridge and the noVNC in-container viewer bridge. A separate
provisioning key is forced through `dexcloud-desktop-provision-command`; sudo can
run only the slot helper.

Install it once:

```sh
# On a trusted operator machine, not in the repository:
ssh-keygen -q -t ed25519 -N '' -f dexcloud-desktop-provision
scp dexcloud-desktop-provision.pub root@desktop-host:/tmp/

# On the desktop host:
cd /opt/dex-cloud/desktop-host
./install.sh /tmp/dexcloud-desktop-provision.pub
rm -f /tmp/dexcloud-desktop-provision.pub
```

Useful install-time overrides are `DEXCLOUD_DESKTOP_SLOTS` (default 4),
`DEXCLOUD_DESKTOP_TENANT_MEMORY` (default `4G`) and
`DEXCLOUD_DESKTOP_TENANT_CPU_QUOTA` (default `200%`). Keep the private key on
the Cloud Admin host inside the existing data volume:

```sh
scp dexcloud-desktop-provision root@cloud-admin:/opt/dex-cloud/data/desktop-provision-key
ssh root@cloud-admin chown 1000:1000 /opt/dex-cloud/data/desktop-provision-key
ssh root@cloud-admin chmod 600 /opt/dex-cloud/data/desktop-provision-key
rm -f dexcloud-desktop-provision dexcloud-desktop-provision.pub
```

Set `LUNABOT_CLOUD_DESKTOP_HOST`, `_PROVISION_KEY=file:/data/desktop-provision-key`
and `_HOST_PUBLIC_KEY`. The host public key must be verified out of band on first
use; after that, `ssh-keyscan -t ed25519 <host>` plus `ssh-keygen -lf` can be
compared with the trusted fingerprint. Store only `<key-type> <key-body>` in the
environment, without the host name or comment.

When a Cloud is provisioned the Admin generates a separate tenant key, asks the
helper for a free slot, injects only that tenant's SSH connection into the Cloud
home, and releases the slot when the Cloud is deleted. The helper removes the
tenant key and wipes the tenant rootless Docker data root before reuse.

## Relay keys

Generate once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put it in `LUNABOT_CLOUD_RELAY_TOKEN_SEED`. The relay only needs the public key:

```sh
docker compose -f /opt/dex-cloud/compose.yaml exec -T cloud node -e "
const c=require('crypto');
const seed=Buffer.from(process.env.LUNABOT_CLOUD_RELAY_TOKEN_SEED,'base64url');
const key=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
console.log(JSON.stringify({k1:c.createPublicKey(key).export({format:'jwk'}).x}));"
```

That JSON is `RELAY_TOKEN_KEYS` in the relay's environment. Rotate by adding a
second entry (`k2`) to both sides, shipping it, then removing `k1`.

## Data and backups

Everything lives in `data/`:

- `dex-cloud.db` and its WAL files: accounts, sessions, installations, plans;
- `downloads/lunabot.apk`: the APK `/download/lunabot.apk` serves (`/download/dexbot.apk` redirects here);
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
