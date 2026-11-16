# Absorbing upstream into this fork

This fork does **not** share git history with `milind-soni/Luna Bot`. It was
imported as a squashed 20-commit tree at upstream `v0.1.89`, so an ordinary
`git merge` has no base to work from (`git merge-base` returns nothing) and a
`--allow-unrelated-histories` merge would present every file as a conflict.

The sync is therefore a **content rebase**: apply the fork's own diff, taken
against the upstream tag the fork was cut from, onto the current upstream tree.
This is the procedure that produced `sync/upstream-0.1.152`; repeat it for the
next upstream release.

## 1. Fetch and measure

```sh
git fetch upstream --tags
git diff --stat v0.1.89 upstream/main | tail -3     # how far upstream moved
git diff --name-only v0.1.89 main > /tmp/fork-files.txt
git diff --name-only v0.1.89 upstream/main > /tmp/up-files.txt
```

Compare the two lists: the overlap is the real merge work, everything else is
either the fork's alone (apply as-is) or upstream's alone (take upstream).

Also check whether upstream still ships a directory the fork owns:

```sh
git ls-tree -r --name-only upstream/main android | wc -l
```

At 0.1.152 that is `0` — upstream dropped `android/` after v0.1.89, so the
fork's Android client is now a fork-only tree and comes over wholesale.

## 2. Rebase in a worktree, never in the working copy

The working copy usually has in-flight work (and another session may be
editing it). Do the sync elsewhere:

```sh
git branch -f sync/upstream-<version> upstream/main
git worktree add /tmp/omb-sync sync/upstream-<version>
cd /tmp/omb-sync
pnpm install --ignore-scripts      # upstream's dependency set, not the fork's
```

Bring the fork-owned trees over first — they cannot conflict because upstream
has no copy:

```sh
git checkout main -- android
git checkout main -- README.zh-CN.md docs/*.md
```

Then apply the fork's non-Android diff with three-way merging, so upstream's
newer versions win per hunk:

```sh
git diff --binary v0.1.89 main -- . ':(exclude)android/**' ':(exclude)docs/*.png' > /tmp/fork-rest.patch
git apply -3 /tmp/fork-rest.patch
```

## 3. Resolve by policy, not by preference

`git apply -3` leaves `UU`/`AA` entries. Resolve them in two classes:

* **Upstream-owned features the fork had backported** (at 0.1.152:
  `electron/cloud-account*`, `companion/src/{proxy,routes}.ts`,
  `src/components/CloudAccountSettings.tsx`, `Composer`, `SettingsModal`,
  `composer-attachments`, `scripts/testing/reply-focus-ui.e2e.test.ts`,
  `docs/verification/cloud-account.md`): take upstream — keeping ours would
  regress the feature.
  ```sh
  for f in $(git diff --name-only --diff-filter=U | grep -v '^android/'); do
    git checkout --ours -- "$f"
  done
  git add -A
  ```
* **Fork features** (the ZCode driver, the live reply bubble, pi pooling):
  re-apply them deliberately on top as their own commits. Do not try to lift
  them out of the conflict — upstream rewrote the files they touch
  (`pi.ts`, `ChatView.tsx`, `turn-status.ts`), so a fresh implementation
  against the new code is faster and safer than resolving a stale patch.

## 4. Re-apply the fork's desktop features

At the 0.1.152 sync these needed real ports, not copies:

| Feature | Where | What changed upstream |
|---|---|---|
| ZCode engine | `server/drivers/zcode.ts` + registration | nothing — the driver compiled unchanged |
| Live reply bubble | `src/state/turn-status.ts`, `ChatView`, `GroupView` | upstream keeps no reply text in the live turn |
| pi warm session | `server/drivers/pi.ts` | driver rewritten; MCP scope read at spawn |

**pi pooling has a security constraint:** the MCP extension reads the tool
scope, approval mode, integrations and model inject file *at spawn*. A warm
child may only be reused while all of those are unchanged, so the reuse key is
`cli + cwd + toolScope + approvalMode + ask_user + model + mcpServers`; any
change closes the child. Never pool across an approval-mode change.

## 5. Locales

`en.json` grows most releases (2714 keys at v0.1.89, 10089 at 0.1.152). Never
carry the old `zh.json` over — take upstream's, then fill the difference:

```sh
pnpm exec node scripts/generate-locale.mjs --check   # reports the percentage
```

Translate only the missing keys, keep existing values byte-identical, and add
`sha256(english)` entries to `src/locales/source-hashes.json` or `--check`
fails. Pure product names / identifiers / units stay in English.

## 6. Verify before claiming anything

```sh
pnpm exec tsc -p tsconfig.server.json --noEmit
pnpm exec tsc -b
pnpm exec vitest run server/drivers/pi.test.ts server/drivers/zcode.test.ts \
  src/state src/locales
pnpm package:mac
```

`AGENTS.md` applies: a conversation change is only "working" after the isolated
fixture recipe in `docs/verification/` has driven it.

## 7. Land it

The fork's `main` is replaced by the sync branch — with a backup, and only
after the working tree is clean:

```sh
git stash push -u -m "wip"
git branch main-pre-sync main
git checkout main
git reset --hard sync/upstream-<version>
git stash pop
```

## Known follow-ups

* **Auto-update still points at upstream** (`electron-builder.yml` publish →
  `milind-soni/Luna Bot`). An upstream release would overwrite a build of
  this fork. Point it at this repository (and start bumping the version)
  before shipping.
* `android/` is fork-only now; upstream no longer carries it, so there is
  nothing to sync there — but nothing stops upstream from reintroducing one.
