# Releasing

Luna Bot publishes its desktop installers on
[liguan-89/lunabot](https://github.com/liguan-89/lunabot/releases). Installed
apps do not read those releases: `app-update.yml` in every build points at the
generic feed this fork controls,
`https://cloud.dexai.vip/desktop` (see `electron-builder.yml`). A release is
therefore two things — a GitHub draft carrying the installers, and the
artifacts plus `latest*.yml` uploaded to that feed directory.

For a normal release, run **Actions → Prepare next release → Run workflow** and
choose a patch, minor, or custom version. It opens a tiny version-bump PR;
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The existing **Actions → Release → Run workflow** button remains available for
reruns and recovery. It builds macOS arm64, Windows, and Ubuntu from a single
pinned commit, verifies every artifact the way a user would receive it, and
assembles the draft release in this repository. It writes to no other
repository.

Tick **publish** to publish the draft. Leave it unticked to review it; when you
publish that draft in GitHub's UI, upload the same assets and `latest*.yml`
files to `https://cloud.dexai.vip/desktop` (the server's
`/data/downloads/desktop` directory) so installed apps see the new version.

The release commit must have passed CI on every platform: the **CI passed on
the release commit** job waits (while the platforms build) for a ci.yml run
whose `CI` check passed with every Linux, Windows and macOS shard, on the
pinned commit or a commit with the same tree, and stops the release before any
draft if the commit's CI failed. A push to main runs the Linux shards only, so
unless the release branch's own CI (started by **Prepare next release**) or a
nightly run covered the same tree, the job runs the full CI on the commit
itself on a temporary `release-ci/v<version>` branch, which takes about as
long as the platform builds. After a flaky failure, re-run the failed CI jobs;
a release still waiting picks up the new attempt, and a release that already
stopped needs only `gh run rerun <id> --failed`. `ship_without_ci` skips the
wait, for emergencies only. See [CI job selection](ci.md#main-and-releases).

The workflow refuses to overwrite an already-published version. Manual Release
runs still require `package.json`'s version to be bumped on the selected ref.
A release is rejected if any installer, stable download
name, updater feed, blockmap, size, or digest is absent or inconsistent.

GitHub generates the release body from pull requests since the previous tag.
The docs changelog reads this repository's published releases and caches them
for five minutes. Configure the optional Vercel hook below to rebuild the docs
immediately after publication; otherwise the live cache or the next normal docs
deployment refreshes it.

## Data format and rollback

Each release records the data-folder formats it writes and reads:
**Prepare next release** runs `scripts/record-data-format.mjs`, which writes
`server/data-format-released.json` into the version-bump commit. The next
release's changes are tested against that record, so a version never writes
data the release before it cannot read
([CONTRIBUTING.md, "Changing how data is stored"](../CONTRIBUTING.md#changing-how-data-is-stored)).
A version bump made by hand needs the same command, or
`server/data-format.test.ts` fails on the mismatched version.

## Promote a release to stable

Self-hosted servers do not follow the newest release: they follow `stable`.
A release becomes stable only after our own Clouds have run it for 48 hours.
Then run **Actions → Promote to stable → Run workflow** with the version
(`X.Y.Z`) and tick that the 48 hours are done.

The workflow builds nothing. It:

1. refuses a version that is not a published, full release, or that was
   published less than 48 hours ago (`urgent` skips the wait, for a fix that
   cannot wait);
2. checks that the release's server image has `linux/amd64` and `linux/arm64`,
   and reads its digest and the Cloud home image's;
3. refuses to move stable back to an older version unless `allow_older` is
   ticked;
4. moves the `stable` tag of `ghcr.io/liguan-89/lunabot` and of
   `ghcr.io/liguan-89/lunabot-cloud-home` to those digests;
5. commits `stable.json` (version, both images by digest, and every version
   that was stable in the last 90 days) to the `channels` branch. When that
   fails after the tags moved, the tags are put back to the digests the
   published record still names.

It reads the current record before it writes the next one. Only a `channels`
branch that does not exist counts as "no record yet"; any other failure to read
it stops the run, so a network error never skips the move-back check or drops
the history.

Servers read
`https://raw.githubusercontent.com/liguan-89/lunabot/channels/stable.json`:
the update check (`server/update-check.ts`) for the version, and
`deploy/update.sh` for the image to pull. `latest` still follows `main` and is
never moved by this workflow. Running it again with the same version changes
nothing, and repairs a run that stopped between the tag and the record.
Until a first version is promoted, both fall back to the newest release. The
`channels` branch is written only by this workflow; do not edit it by hand.
The checks live in `scripts/stable-channel.mjs`.

### How a server takes an update

One routine, in the two places that can run it. A server cannot replace its
own container, so neither is the server process: a connected server's update
is the connector's `update` job, and a standalone Docker Compose install's is
`deploy/update.sh`, run on the host by its owner. They are two programs (the
connector drives a container it made itself through the Docker API and has no
shell; a Compose install has to be swapped by `docker compose` on the host),
held to the same steps and the same promises:

| Step | Connector (`connector/src/home.ts`) | Standalone (`deploy/update.sh`) |
| --- | --- | --- |
| Image by digest, before anything stops | `ensureImage`, `checkImage` | `docker pull` of the record's `…@sha256:…` |
| Room for the copy | `ensureRoomForCopy` | `room_for_copy` |
| Stop, copy `/data` aside | `stopAndCopy` → volume `mausbot-snapshot` | `stop_server` (checked stopped), `copy_aside` → a new volume `<project>_data-before-update-<time>`, compared with the data file by file; the copy before it is removed only then |
| Never older | the update runner refuses an older image (exit 5) | `older_reason`: by the version the server reports; exit 5 unless `--allow-older` |
| Start the new image | `createContainer`, `startHome` | `LUNABOT_IMAGE` in `.env`, `docker compose up -d` |
| Healthy, and bots can start | signed health report names the image; the bot box still passes every check it passed before | `/api/health` three times running, the version it reports, `lunabot doctor` if it passed before, Caddy |
| On failure | `rollBack`: old image and the copy, reply `update_rolled_back` | `roll_back`: the copy (into a new folder, checked, then swapped in), `.env` and the old image, exit 1 with the reason; a restore that fails keeps the journal, exit 2 |
| Interrupted | the operation in `home.json`; `recover` at the next start | `.update/journal`; a hangup is ignored, Ctrl-C undoes at once, and the next run keeps a healthy new version or asks before it puts data back |
| Run twice | a job id is answered again, never run again | "already runs …, nothing to do" |

`connector/test/home.test.ts` and `connector/e2e/run.sh` hold the connector to
this; `scripts/testing/deploy-update.test.ts` holds the script to it. A change
to one side's steps belongs in the other too.

## Desktop update feed

`app-update.yml` is baked into every packaged desktop app and names the generic
provider, `https://cloud.dexai.vip/desktop` (`electron-builder.yml`'s
`publish`). That is the only source installed apps read, and `release.yml`
gates every platform build on it:

The release matrix is deliberately minimal: macOS arm64 (`dmg` + `zip`),
Windows x64 (`setup.exe`), Linux x64 (`amd64.deb` only — no AppImage or RPM),
and the Android channel APK. `release.yml` gates every platform build on the
feed:

1. The GitHub release on `liguan-89/lunabot` is the distribution record: the
   installers, the stable download names (`LUNABOT.dmg`, `LUNABOT-setup.exe`,
   `LUNABOT-amd64.deb`), the blockmaps, `latest*.yml` and
   `SHA256SUMS-ubuntu-x64.txt` — 14 assets.
2. Installed apps update from the generic feed. `pnpm publish:feed` uploads
   the assembled asset set plus the channel APK to the Cloud server's
   `/data/downloads/desktop` directory (served under `/desktop/*`), swaps
   `downloads/dexbot.apk` and rewrites `downloads/update.json`, then deletes
   every `LUNABOT-<old-version>-*` file and all `*.bak-*` backups. The server
   therefore keeps only the newest version; `--dry-run` prints the plan
   first. Hosts and paths come from `LUNABOT_PUBLISH_HOST` (default
   `wholesale`) and `LUNABOT_PUBLISH_DATA_DIR` (default
   `/opt/dex-cloud/data`).
3. There is no second repository and no mirror. Nothing in the release pipeline
   writes outside `liguan-89/lunabot`.

The npm package is published separately and its versioned `.tgz` is attached
only to this repository's release. It is not a desktop updater artifact.

## macOS signing

The macOS job produces an unsigned (ad-hoc signed) arm64 build: this fork keeps
no Developer ID certificate or App Store Connect key in CI, so the workflow has
no signing or notarization steps. Users see Gatekeeper's "unidentified
developer" prompt on first launch (`README.md` says so). Windows is unsigned
for the same reason, and `electron-builder.yml` deliberately writes no
`publisherName` — electron-updater skips the signature check without one, so
auto-update keeps working. To start signing later, add the certificate secrets
below and restore the import/notarize/staple steps before the re-zip step.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stale hashes after the artifacts were rewritten, and a finished release sitting
invisible as a draft. Don't remove a gate without reading the comment above it.

## Bundled browser gates

Desktop builds also stage a pinned engine and Chromium Headless Shell before
packaging. Pre-signing checks validate complete resources and upstream hashes;
native browser smoke tests run on the packaged output. See
[browser packaging](browser-packaging.md) for update ownership, license
provenance and Linux sandbox constraints. Missing browser resources must fail
the build, not ship an installer that downloads them on first use.

## One-time setup: release secrets

Set these in **Luna Bot → Settings → Secrets and variables → Actions**. The
release workflow currently needs **none** of them: it publishes with the
workflow's scoped `GITHUB_TOKEN`, and the macOS build is unsigned. The entries
below are what signing would require if it is turned on later.

The **Prepare next release** workflow also needs
**Settings → Actions → General → Workflow permissions → Allow GitHub Actions
to create and approve pull requests** enabled. The workflow only creates the
version PR; it never approves or merges it.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD` (only for signed builds)

The Developer ID Application certificate, exported from a Mac:

```sh
# Keychain Access → My Certificates → "Developer ID Application: …" →
# right-click → Export… → .p12 with a strong password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID` (only for notarization)

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

### 3. Optional `DOCS_DEPLOY_HOOK_URL`

In Vercel, open the docs project and create a **Deploy Hook** for its production
branch. Store that private URL as the `DOCS_DEPLOY_HOOK_URL` repository secret.
Publishing a release then requests a fresh docs deployment so the generated
changelog appears immediately. Do not put the hook URL in source control.

### Local fallback

The hand-cut path still works when Actions is down or a release needs surgery:
`pnpm package:mac` (ad-hoc signed unless a Developer ID certificate is in the
keychain; notarize with `xcrun notarytool submit … --keychain-profile
AC_PASSWORD` and staple only if it is), re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload the complete asset set to a draft
release here, and always verify the published bytes against the feed on disk by
downloading them back.
