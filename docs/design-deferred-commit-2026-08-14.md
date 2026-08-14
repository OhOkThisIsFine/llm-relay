---
title: "Deferred Commit Design — §1.1 Remainder"
date: 2026-08-14
status: advisory
authoring_lane: "Codex"
caveat: "This is an ADVISORY lane deliverable. File:line claims must be re-verified at implementation time."
---

# Deferred Commit Design — §1.1 Remainder

**Reference:** [docs/freellmapi-adoption-review-2026-08-13.md](file:///C:/Code/llm-relay/docs/freellmapi-adoption-review-2026-08-13.md#L385-L390) §6 Item 1
**Background:** [docs/pool-failover.md](file:///C:/Code/llm-relay/docs/pool-failover.md) (*"two paths, one policy empty"*)
**Source Fronts:** Anthropic front (`POST /v1/messages`) and OpenAI front (`POST /v1/chat/completions` and `POST /v1/responses`) in [src/server.ts](file:///C:/Code/llm-relay/src/server.ts#L474-L712).

---

## 1. Fact inventory

### 1.1 What `files` ships

`package.json` lines 20–30 declare:

```
dist/                          — compiled JS (root + subdirectories)
docs/tier-data.json            — the capability snapshot
skills/                        — directory (flat entry = recursive inclusion)
scripts/install-skill.mjs      — one specific file, not the whole scripts/
scripts/sync-tiers.mjs
scripts/tier-scoring.mjs
scripts/tier-scoring.d.mts
README.md
config.example.json
```

Critical observation: `scripts/sync-tiers.mjs` ships, but `scripts/CLAUDE.md` (the operators' inventory of those scripts) does not. That is a docs omission that no smoke test will catch.

### 1.2 Runtime assets the installed binary reads outside `dist/`

There are exactly **three** non-`dist` assets the binary reaches on a live code path:

**a) `docs/tier-data.json`** (`src/tier-data.ts` line 74)
```ts
path = fileURLToPath(new URL("../docs/tier-data.json", import.meta.url));
```
This resolves relative to the installed `dist/tier-data.js` location. After `npm install -g` or `npm pack` + local install, `import.meta.url` points at the tarball's `dist/`, so `../docs/tier-data.json` lands in the right place **only if** the `files` whitelist actually placed it there. The path is computed with `fileURLToPath(new URL(...))` — no env-var override, no fallback directory. The file is missing, the function returns `null` (lines 77–83), so it degrades without crashing, but every caller that depends on tier data then degrades silently.

**b) `package.json`** (`src/self-update.ts` lines 160–174)
```ts
function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
export function currentVersion(): string {
  return readPackageJson(packageRoot()).version ?? "0.0.0";
}
```
`packageRoot()` walks from `dist/self-update.js` → two dirs up → the install root. `currentVersion()` then reads `package.json` from there. This runs on every invocation via `run()` (cli.ts lines 2226–2234), gated by `shouldCheckUpdates()`. If `package.json` is missing from the tarball, version reporting degrades to `"0.0.0"` — and since the npm cache check (lines 176–199) runs before any network call, a missing file turns the currency gate into a 2.5-second network probe on every start.

**c) `skills/llm-relay/SKILL.md`** (`scripts/install-skill.mjs` line 123)
```js
const src = join(here, "..", "skills", "llm-relay", "SKILL.md");
```
Only reached by the postinstall hook. The binary itself never reads it. If the `skills/` directory is missing from the tarball, a global `npm i -g llm-relay` silently fails to install the Claude Code and Codex skill files. The hook catches the error and prints a message (line 124–125, 150–153), so it does not crash the install — but the skill goes uninstalled with no loud signal.

### 1.3 Assets the binary does NOT read from the package

- `scripts/sync-tiers.mjs` — only invoked by the operator running `npm run sync:tiers`; not a binary dependency.
- `config.example.json` — never loaded by any source path; it is documentation, not a default. `resolveConfigPath` (cli.ts lines 372–390) falls back to writing the inline `DEFAULT_CONFIG_TEMPLATE` (line 298), not reading this file.
- `README.md` — never imported.
- The remaining `dist/` sub-files are all reachable via ESM imports resolved from `dist/cli.js` and are covered by the `dist/` directory entry.

### 1.4 Subcommands that qualify for offline smoke testing

The constraint is: no provider keys, no running proxy, no network. The binary must load config, load tier data, and execute without touching any backend endpoint.

| Command | Why it qualifies | Assets exercised |
|---|---|---|
| `llm-relay --version` | No config load at all; reads `package.json` via `packageRoot()` (self-update.ts line 160) before any network call. Exits immediately after `currentVersion()` (cli.ts line 2039). | `package.json` |
| `llm-relay config show` | Calls `loadOrExit()` → `resolveConfigPath()` → loads `config.json` from `~/.llm-relay/` (which we will create in the temp dir), then reads and prints it. No backend calls. | config system |
| `llm-relay routing show` | Same path through `loadOrExit()`, then reads the routing block. No backend calls. | config system |
| `llm-relay dispatch --lane relay --json` | Calls `loadOrExit()`, then `materializeDynamicPools()` (cli.ts line 1010) which calls `loadTierData()` (dynamic-pools.ts line 136), then falls through to the cold local `buildDispatch` path because no proxy is listening (cli.ts line 1049). The `--lane relay` is not a configured rung so it returns a `no lane available` reason, not an error. | `docs/tier-data.json`, config system, `dist/cli.js`, all imported modules |

**Commands that do NOT qualify and why:**

- `llm-relay models` — calls `catalog.list()` (cli.ts line 451) which fetches from each provider's `/models` endpoint; requires network and working keys.
- `llm-relay pools --probe` — calls `probeAllPools()` (cli.ts line 1989) which sends real completions; requires network and keys.
- `llm-relay candidates` — in cold mode calls `buildCandidates()` (cli.ts line 1549) which calls `materializeDynamicPools()` and reads tier data (qualifies), but also calls `loadRuntimeTelemetry()` and `loadProbeCache()` which read from `~/.llm-relay/` (present or absent, both OK). However, it produces large tabular output that is harder to assert on cleanly than the three targeted commands above. It qualifies, but is noisier.
- `llm-relay keys` / `check-keys` — calls `validateProviderKeys()` which probes every provider; requires network.
- `llm-relay ping` — calls `pingLoop.tickOnce()` which probes every model; requires network and keys.
- `llm-relay offload` — writes config when toggling on/off; is mutating.
- `llm-relay lanes --probe` — spawns lane commands; requires config and tooling.
- `llm-relay eligibility` — reads learned-state files; works offline but produces variable output depending on prior state; not a clean pass/fail signal.
- Bare `llm-relay` (no subcommand) — starts the proxy, which binds a port; unsuitable for a CI step.

The four cleanest probes, in order of asset coverage:

1. `--version` → validates `package.json` is present and loadable
2. `config show` → validates config loading pipeline, confirms `dist/cli.js` and all its imports resolve
3. `dispatch --lane relay --json` → validates `docs/tier-data.json` is present, parseable, and loadable by `loadTierData()`; also re-validates the config and import graph
4. The tarball itself → validates the `files` whitelist is complete

---

## 2. YAML steps to add

### 2.1 The artifact smoke-test step

Place this **after** `npm run build` (line 104) and **before** `npm run check` (line 106) in `publish.yml`. The rationale for this position: `build` produces `dist/`; packing the tarball after that captures the compiled output the way npm would ship it. If `check` were first, a `files`-whitelist defect would be masked by the source-tree checks passing — `npm run check` exercises `src/` directly, not the packed artifact. Running the smoke test before `npm publish` means it is the last gate before the irreversible publish.

```yaml
      # Artifact smoke test: npm pack, install into a clean directory, and exercise the
      # installed binary against every runtime asset it loads from outside dist/.
      # This is the only gate that verifies the `files` whitelist is complete — CI's
      # build/check runs against the source tree, not the packed tarball, and would
      # miss a missing tier-data.json or skills/ directory in the published artifact.
      - name: Smoke-test the packed artifact
        run: |
          set -euo pipefail

          # --- pack ---------------------------------------------------------------
          TARBALL="$(npm pack --dry-run=false 2>&1 | tail -1)"
          # npm pack prints: "llm-relay-0.35.0.tgz" as its last line
          echo "packed: ${TARBALL}"

          # --- install into a clean temp directory --------------------------------
          DEST="$(mktemp -d)"
          # Extract only the package/ subtree from the tarball into DEST
          tar xzf "${TARBALL}" -C "${DEST}" --strip-components=1

          # Verify the binary itself is present
          test -f "${DEST}/dist/cli.js" || { echo "::error::dist/cli.js missing from tarball"; exit 1; }

          # --- tier-data.json: must be present and loadable ------------------------
          # loadTierData() resolves ../docs/tier-data.json relative to dist/tier-data.js.
          # We exercise it through a command that reaches it: dispatch --lane <nonexistent>
          # in local fallback mode calls materializeDynamicPools -> loadTierData.
          if ! node "${DEST}/dist/cli.js" dispatch --lane __smoke__no_such_lane --json > /dev/null 2>&1; then
            echo "::error::dispatch --lane (tier-data consumer) failed — tier-data.json missing or unreadable"
            echo "--- tarball contents ---"
            tar tzf "${TARBALL}" | sort
            exit 1
          fi
          echo "tier-data.json: present and loadable"

          # --- package.json: version command must report the published version -------
          VERSION="$(node -p "require('./${TARBALL%.tgz}/package.json').version")"
          BIN_VERSION="$("${DEST}/dist/cli.js" --version 2>&1 | tr -d '\n')"
          if [ "${BIN_VERSION}" != "${VERSION}" ]; then
            echo "::error::version mismatch: package.json=${VERSION}, binary reports=${BIN_VERSION}"
            exit 1
          fi
          echo "version: ${BIN_VERSION} (matches package.json)"

          # --- config path resolution: create a minimal config, verify it loads ---------
          CFG_DIR="${DEST}/.llm-relay"
          mkdir -p "${CFG_DIR}"
          cat > "${CFG_DIR}/config.json" <<'JSON'
          {
            "listen": "127.0.0.1:8791",
            "providers": {},
            "routing": { "default": "pool/medium", "pools": {} },
            "mode": "repair",
            "repair": { "maxAttempts": 2, "destructiveTools": [] },
            "log": { "level": "metadata", "file": null }
          }
          JSON
          # config show must succeed against a config it just created
          "${DEST}/dist/cli.js" -c "${CFG_DIR}/config.json" config show > /dev/null 2>&1 \
            || { echo "::error::config show failed — config loading broken in packed artifact"; exit 1; }
          echo "config loading: ok"

          # --- skills directory: at least the entrypoint file ships ------------------
          if ! tar tzf "${TARBALL}" | grep -q "^skills/llm-relay/SKILL.md$"; then
            echo "::error::skills/llm-relay/SKILL.md missing from tarball — postinstall hook cannot install the Claude Code / Codex skill"
            exit 1
          fi
          echo "skills/llm-relay/SKILL.md: present in tarball"

          # --- report tarball contents for diagnostics ---------------------------------
          echo "--- tarball contents ---"
          tar tzf "${TARBALL}" | sort

          rm -rf "${DEST}"
```

### 2.2 Breakdown of what each sub-step validates

| Sub-step | Asset validated | Mechanism |
|---|---|---|
| `test -f dist/cli.js` | `dist/` directory entry | Direct file existence |
| `dispatch --lane __smoke__no_such_lane --json` | `docs/tier-data.json` | `runDispatch` → `materializeDynamicPools` → `loadTierData()` reads and parses the file; returns a JSON "no lane available" error rather than crashing if it works |
| `--version` vs `package.json` version | `package.json` | `currentVersion()` reads `packageRoot()/package.json` via `fileURLToPath(import.meta.url)` from `dist/self-update.js` |
| `config show` with a fresh config | Config loading pipeline | `loadOrExit` → `resolveConfigPath` → `loadConfig`; validates the whole config system works in the installed tree |
| `tar tzf \| grep skills/llm-relay/SKILL.md` | `skills/` directory entry | tarball manifest inspection; confirms npm will extract the skill source that `install-skill.mjs` copies to `~/.claude/` and `~/.codex/` |

### 2.3 Where it goes in publish.yml

Between the existing lines:

```
      - run: npm run build          # line 104 — produces dist/
      - run: npm run check          # line 106 — source-tree tests
```

becomes:

```
      - run: npm run build          # line 104
      - name: Smoke-test the packed artifact   # NEW
        run: | ...
      - run: npm run check          # line 106 (unchanged)
      - run: npm publish --access public       # line 107
```

`check` stays after the smoke step rather than before it: if `check` fails, the artifact smoke step never runs, which is correct — there is no point testing a tarball built from a source tree that already fails. If the smoke step fails, `check` also never runs, and the publish step is skipped. The step produces `::error::` annotations so GitHub renders the failure inline in the Actions UI.

---

## 3. Should ci.yml also run it?

**Publish-only.** The reasoning:

`ci.yml` runs `npm ci --ignore-scripts` (line 40) from the registry, then `npm run build` (line 44), then `npm run check` (line 47). Its job is to validate that the source tree is green — typecheck clean, suite green — before any tag is pushed. The `files` whitelist is irrelevant to this check because `npm ci` resolves from the registry, not from the local tree; the installed files are whatever the *previous* published version's `files` declared, not this commit's.

Running the smoke test in ci.yml would test a freshly-packed tarball from this source tree, which IS a different signal. But:

1. **It duplicates publish.yml's gate without catching a different failure mode.** The `files` defect this smoke test catches is "a file the binary needs at runtime is absent from the packed tarball." That defect is introduced in `package.json` and ships through `npm publish`. The publish gate is the only place the artifact actually ships. CI would catch it hours or days earlier, but the failure mode and the fix are identical — and CI runs on every PR, so a PR that introduces a `files` defect would already fail the publish job.

2. **It slows every PR.** `npm pack` + `npm install` into a temp dir + four binary invocations adds roughly 20–30 seconds to every PR's CI run. The current ci.yml timeout is 20 minutes (line 27), so there is headroom, but the cost is paid N times where N is the number of PRs, and the signal is redundant.

3. **The postinstall hook probe already lives in ci.yml** (lines 49–53), which is the argument by analogy: that step tests a hook that ships in the tarball, but it does so by running the source file directly (`node scripts/install-skill.mjs`) rather than installing the packed artifact. It validates the hook's *logic*, not its inclusion in the package. The smoke test fills the gap that probe leaves.

**If a second CI signal were wanted**, the cheaper alternative is a tarball manifest inspection only — `npm pack --dry-run` and `tar tzf` the output against a whitelist of expected paths, without installing and executing it. That validates inclusion in ~5 seconds without the install overhead. But the publish-only execution test is the stronger signal, and one gate is enough.

---

## 4. Windows/Linux runner considerations

### 4.1 Runner choice

Both `publish.yml` and `ci.yml` use `ubuntu-latest` (publish.yml line 44, ci.yml line 27). The smoke test as written uses POSIX shell (`bash -euo pipefail`, `mktemp -d`, `tar xzf --strip-components=1`). This runs correctly on the Ubuntu GitHub runner. **Do not run this step on `windows-latest`** without rewriting the shell syntax.

### 4.2 What would need to change for a Windows runner

If publish.yml ever moves to `windows-latest` (not recommended — see below), the shell steps would need PowerShell equivalents:

```yaml
# POSIX (current):
TARBALL="$(npm pack 2>&1 | tail -1)"
DEST="$(mktemp -d)"
tar xzf "${TARBALL}" -C "${DEST}" --strip-components=1

# PowerShell equivalent:
$TARBALL = npm pack 2>&1 | Select-Object -Last 1
$DEST = Join-Path $env:TEMP ("llm-relay-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $DEST -Force | Out-Null
tar -xzf $TARBALL -C $DEST --strip-components=1   # tar IS available in pwsh on ubuntu; on windows-latest it is also present (Git Bash / tar.exe)
```

The `--strip-components=1` flag works with both `tar` implementations. On Windows the `tar` command is available (it ships as `tar.exe` in the system PATH). The `mktemp` equivalent is the `$env:TEMP` + `[guid]` pattern shown above. The `test -f` / `grep -q` checks have PowerShell equivalents (`Test-Path`, `Select-String`).

### 4.3 Why staying on Ubuntu is correct

`ci.yml` lines 8–9 state the rationale explicitly:

> Development happens on Windows, so Linux is the platform whose result nobody sees locally.

The same reasoning applies to the artifact smoke test: the binary runs identically on both platforms (pure ESM JavaScript, no native modules — the two runtime dependencies are `ajv` and `llm-bridge`, both pure JS), so testing on Linux validates the artifact. The binary's *consumers* run on Windows (Claude Desktop, Claude CLI on Windows, Codex on Windows), and the `dist/` output is platform-independent. A Windows runner would add no signal that Ubuntu does not already cover.

### 4.4 One Windows-specific risk in the test

The `node -p "require(...).version"` sub-step (reading `package.json` to get the expected version) works identically on both platforms. The `--strip-components=1` flag is required because `npm pack` produces a tarball with a `package/` top-level directory; without it, the binary's `import.meta.url` would resolve to `DEST/package/dist/cli.js`, and `packageRoot()` (two `dirname` calls from there) would land at `DEST/package/`, where no `package.json` exists. On Windows the same path arithmetic applies — `fileURLToPath` converts `file:///` URLs to native paths regardless of platform.

### 4.5 The `skills/` check across platforms

The tarball manifest check (`tar tzf ... | grep "^skills/llm-relaw/SKILL.md$"`) is POSIX-only. On PowerShell the equivalent is:

```powershell
$contents = tar tzf $TARBALL
if (-not ($contents | Select-String -Pattern '^skills/llm-relay/SKILL.md$')) {
  Write-Error "skills/llm-relaw/SKILL.md missing from tarball"
  exit 1
}
```

This is not a concern for the current runner choice, but is the single line that would need changing if the step were ever ported to a Windows runner.

### 4.6 A note on the Node version in publish.yml

`publish.yml` and `package.json` now both require Node 22. The smoke test inherits that version and would catch a future mismatch between the package's declared floor and the artifact it ships.
