# Custody sprint plan — Stage 3 of the credential-fleet program (2026-08-24)

Program of record: [credential-fleet-design-2026-08-16.md](credential-fleet-design-2026-08-16.md)
§2 (custody), §8 Stage 3, §7 (test plan), §6 (compatibility contract). This plan adapts that
design to the CURRENT source: the design predates Stage 0/1 pooling, and a recon pass on
2026-08-24 found several of its structural assumptions drifted. Corrections and decisions are
recorded here so the implementer plugs into reality, not the 2026-08-16 snapshot.

Owner approval: custody was APPROVED and queued as the next sprint (owner decision 2026-08-23,
`docs/metering-reconciliation-2026-08-22.md` §6). P1 (platform coverage) resolves inside this
build — see D2.

Target release: **v0.45.0**.

## 1. Recon corrections to the design (verified 2026-08-24, file:line against `main` @ `2209f88`)

1. **There is no single flat `resolveCredential()` everything derives from.** Two independent
   env-only leaf resolvers exist: `resolveCredential()` (`src/authEnv.ts:148`, alias-aware,
   legacy/implicit slots) and `resolveCredentialExact()` (`src/authEnv.ts:172`, declared-only, no
   alias fallback — deliberate, comment at 167-171). They are unified one level up by
   `resolveCredentialSlot()` (`src/credential-fleet.ts:95-102`), which dispatches by
   `slot.resolutionMode`. Every fleet-aware consumer funnels through the dispatcher — the request
   path via `resolveAttemptForSlot`, plus candidates/catalog/pool-health/key-checker/ping and
   registry/telemetry/onboarding via `snapshotProviderCredentials`/`aggregateHasKey`.
2. **Two seams BYPASS the dispatcher** and must not be forgotten (each one recreates the design's
   central "correctly built, never consulted" defect if missed):
   - `src/config.ts:969` — `resolveTargets()`'s admission pre-filter calls
     `credentialState(t.authEnv, process.env, t.provider)` directly. A LEGACY-authEnv provider
     whose key lives only in the keystore is `declared-missing` there and is dropped from routing.
   - `src/server.ts:457` — the reshaper's own credential (`cfg.reshaper.authEnv`) resolves through
     the legacy leaf, entirely outside `CredentialSlot`/`CredentialId`.
3. **Presence and value already agree downstream by construction.** `buildForwardHeaders()`
   (`src/server.ts:4507`) and `buildTargetHeaders()` (`src/backend.ts:1314`) read `.state`/`.value`
   off one pre-resolved `ResolvedAttempt.credential` object. No new downstream unification is
   needed; only resolution itself changes.
4. **Resolution has two per-request moments, deliberately**: the main walk resolves once
   (`src/server.ts:1219`, documented immutable for the request) and provider-backed reshaper
   repairs re-resolve at repair-decision time (`src/server.ts:409`). Both must observe the same
   keystore state within one request.
5. **No absolute-System32-path precedent exists in-tree** (design §2.1/§2.9 implies one in
   `winenv.ts`; grep for `System32`/`SystemRoot` finds nothing — `reg`, `icacls`, `cmd.exe` are
   all spawned by plain name today). The custody build introduces the absolute-path rule as a NEW
   deliberate pattern for the binaries that touch the keystore (`powershell.exe`, `icacls`).
6. **`llm-relay keys` has NO subcommand router.** `src/cli.ts:3081-3087` ignores every positional
   after `keys`; `llm-relay keys add …` today silently runs the status check. The router is new
   work, and `classifyCommand()` (`src/cli.ts:3201`) has no `keys` case (falls to read-only), so
   mutating subcommands need one or the self-update gate misclassifies them.
7. **No masked/echo-off prompt exists anywhere in-tree.** `onboarding.ts` uses plain
   `node:readline` with full echo. `keys add`'s echo-off TTY prompt is new terminal handling.
8. **The `.env` writer is non-atomic** (`saveKeysToEnv`, `src/onboarding.ts:187-200`, plain
   `appendFileSync`). The keystore must NOT copy it. The correct write pattern is a combination:
   `src/target-facts.ts:271-279` (tmp + `renameSync`, overwrite allowed — rotate/revoke must
   overwrite, so `control-authorization.ts`'s never-overwrite `linkSync` pattern is wrong here)
   plus `src/control-authorization.ts:130-153`'s restrict-BEFORE-publish ordering
   (`O_CREAT|O_EXCL|O_WRONLY` + 0600 at open → write → fsync → `restrictFile(tmp)` → rename →
   `restrictFile(target)`).
9. **`process-safety-net.ts:124` confirmed**: a non-transport fatal error is `console.error`'d as
   the RAW object, so a child-process error's `.cmd`/`.args`/`.stderr` would print verbatim.
   Keyring spawn errors must be caught and sanitized at the call site; none may escape.
10. **Test conventions** (follow, do not invent): per-module `VITEST` default-path redirect PLUS
    explicit path/env parameters on every public function (`target-facts.ts:138` +
    `test/target-facts.test.ts:260-272`); the pure-argv-builder + injected-spawner split of
    `secret-file-acl.ts:8-14`/`test/secret-file-acl.test.ts`; the sliding-4-char-window `leaks()`
    no-secret-in-output helper (`test/key-checker.test.ts:429-480`); CLI subcommands as exported
    `run*` functions tested in-process with `process.argv` + mocked `process.exit`
    (`test/cli.test.ts:1184-1232`); POSIX mode checks under
    `it.skipIf(process.platform === "win32")` (CI is ubuntu-only — real DPAPI/icacls behaviour is
    NEVER exercised in CI, only injected doubles are; do not claim otherwise).

## 2. Decisions (stated with the rule that shaped them)

- **D1 — the keystore rung is inserted at BOTH leaf resolvers, symmetrically, keyed by env
  NAME.** `resolveCredential()` and `resolveCredentialExact()` each gain the same fallback: when
  every env candidate name misses, consult the keystore for an entry whose `envName` matches (the
  legacy leaf tries the declared name then its curated aliases, in that order; the exact leaf tries
  only the declared name — preserving exactly the alias discipline each leaf already has).
  Precedence is source-major, per the design and `dotenv.ts`'s contract: ANY env hit beats ANY
  keystore hit; the real environment wins because it is the more explicit signal.
  *Alternative rejected:* inserting at the `resolveCredentialSlot` dispatcher alone — it looks like
  "one seam" but `config.ts:969` and `server.ts:457` bypass it (correction 2), so a legacy-authEnv
  provider with a keystore-only key would still be dropped from routing: the design's §2.5 defect
  ("the store would be correctly built, correctly unwrapped, and never consulted") rebuilt one
  layer up. Leaf-level insertion makes both bypass seams keystore-aware with no changes at their
  call sites. Because entries are looked up by `envName`, neither leaf needs a `CredentialId`
  threaded in; the entry's own `id` still travels back on the resolution for provenance.
- **D2 — P1 platform coverage: all three platforms ship, honestly labelled.** Windows DPAPI is
  primary and live-verifiable on this machine. The Linux scrypt-passphrase mode is pure
  `node:crypto` and is exercised for real on the CI ubuntu leg. macOS `security` and Linux
  `secret-tool` ship as code + injected-double tests only — no CI leg and no machine here can run
  them; that residual is stated in the docs rather than papered over ("a guess must never be
  labelled a measurement" applied to test coverage). Neither-available on Linux ⇒ refuse to store,
  per design §2.1 — a silent downgrade is worse than not shipping.
- **D3 — the reshaper credential inherits custody for free via D1.** Its `authEnv` resolves through
  the legacy leaf, and keystore entries carry `envName`, so a stored key whose `envName` matches
  the reshaper's declared variable is found with no reshaper-specific code. No `CredentialId` is
  minted for it (it sits outside the fleet by design); `source` provenance still reports.
- **D4 — `source: "env" | "env-file" | "keystore"` provenance.** `dotenv.ts` records the set of
  names IT populated (module-level, fill-only, cleared on reload) so resolvers can distinguish
  `env` from `env-file` without re-reading the file. Provenance is a label, never a decision input
  (the recalibrated guess rule applied to origin).
- **D5 — store write pattern**: correction 8's combined sequence. Directory `(OI)(CI)` hardening at
  store-directory creation so tmp siblings are born restricted (design §2.9).
- **D6 — CLI surface.** `llm-relay keys` bare and `check-keys` keep today's status behaviour
  byte-compatible. New subcommands: `add`, `list`, `rotate`, `revoke`, `remove`, `export`,
  `import`, `unlock` (passphrase mode only; no-op elsewhere). ⚠ Behaviour change to announce in
  the release notes: `llm-relay keys <word>` used to silently run the status check; unknown words
  now fail with exit 1 naming the valid subcommands (silent misparse of a mutating intent is the
  worse failure). `classifyCommand` gains `case "keys"`: mutating for
  add/rotate/revoke/remove/import/unlock, read-only for bare/list/export/check. All keys
  subcommands are CLI-local only — no `tryServer`, no HTTP (design §2.7); the relay picks up
  changes at its own next resolution (attempt-time resolution already re-reads state per request).
- **D7 — keyring spawn discipline.** `powershell.exe` (Windows PowerShell 5.1) and `icacls` resolve
  from `%SystemRoot%\System32` absolutely — a NEW pattern, deliberate (design §2.1: a PATH shim
  shadowing the binary that handles the secret is itself a hijack vector); `security` and
  `secret-tool` resolve conventionally (no fixed install path exists for them). KEK bytes cross the
  process boundary over stdin/stdout ONLY, read via `[Console]::OpenStandardInput()` raw streams.
  Every spawn is wrapped: caught errors rethrow as a fresh `Error("keyring <op> failed: <class>")`
  carrying none of the child's `.message`/`.stderr`/`.output`/`.cmd` (correction 9). The KEK lives
  in a `Buffer`, `fill(0)` on re-lock; decrypted secrets are never cached keyed by provider.

## 3. Work packets

Each packet lands alone, `npm run build && npm run check` green, one commit, adversarially
reviewed before the next starts. No new runtime deps anywhere (design §5).

### Packet 1 — custody core: `os-keyring.ts` + `keystore.ts` + `secret-file-acl` upgrades

New `src/os-keyring.ts`: KEK wrap/unwrap per platform (dpapi | keychain | libsecret | passphrase),
stdin-only KEK transport, injected-spawner seam (the `SecretFileAclSpawn` split: pure
argv-builders exported and tested in isolation), sanitized errors, refuse-to-store when no
platform mechanism exists.

New `src/keystore.ts`: the §2.4 store format (version 1; `kek` block; `fpSalt`; entries with
`id`/`provider`/`envName`/`ct`/`iv`/`tag`/`fingerprint`/lifecycle timestamps/`disabled`).
AES-256-GCM under the KEK with `authTagLength: 16` pinned; AAD `${version}|${provider}|${entryId}`;
fingerprint = HMAC-SHA256 under the KEK truncated to 8 hex, never a bare digest of the secret.
Charset validation at write AND load (label `^[A-Za-z0-9_.-]{1,32}$`, envName
`^[A-Za-z_][A-Za-z0-9_]*$`); malformed entries DROPPED on load under degrade-to-fresh
(`target-facts.ts` shape: version-gated, corrupt ⇒ fresh empty, never a throw). `VITEST` default
path redirect + explicit `{path}` override on every public function. Writes per D5. Read API shaped
for D1: `lookupByEnvName(envName)` and non-secret `listEntries()` descriptors.

`src/secret-file-acl.ts` upgrades (design §2.9): grant by SID resolved via
`whoami /user /fo csv /nh` (fallback to username when unresolvable), retain SYSTEM
(`S-1-5-18`) and Administrators (`S-1-5-32-544`), a SYNC variant for create-time hardening,
directory hardening with `(OI)(CI)`, `icacls` by absolute System32 path. Existing callers
(`control-authorization.ts:105`, `onboarding.ts:199`) keep working; the fire-and-forget async form
stays for them.

Tests (from design §7): AAD binding (edited `provider` fails decrypt); charset refusal at add +
drop at load; KEK never in any argv the keyring assembles; spawn-error serialization contains
neither argv nor child output (sliding-window `leaks()` helper); VITEST redirect; degrade-to-fresh
on corrupt/wrong-version stores; passphrase mode round-trips (real crypto, CI-runnable); dpapi
wrap/unwrap through an injected double asserting exact argv + stdin payload; icacls arg-builder
rows for SID/SYSTEM/Administrators/(OI)(CI).

### Packet 2 — the resolver keystore rung + admission + degradation

D1 at both leaves; D3 falls out; D4 provenance (dotenv name-set + `source` on resolution results,
threaded onto `ResolvedAttempt.credential` and the snapshot surfaces that already exist);
`config.ts:969` and `server.ts:457` observed keystore-aware by construction — pinned by tests, not
assumed. An unwrappable keystore (missing keyring daemon, roaming profile, forced reset) degrades
the providers it covers with a `Config.warnings` entry and never refuses to boot (design §2.10);
covered providers = providers whose only resolution came from the keystore. The store is NEVER
merged into `process.env` (child processes must not inherit secrets — design §2.5).

Tests: a provider whose key exists ONLY in the keystore survives `resolveTargets` AND produces a
populated auth header on both fronts (the design's headline defect test); state/value/presence
agreement across the source × present/blank/whitespace matrix; env beats env-file beats keystore;
keystore-only reshaper credential resolves; unwrappable keystore ⇒ warning + boot; no
`process.env` mutation; both per-request resolution moments observe one keystore state.

### Packet 3 — CLI lifecycle + docs

The `keys` subcommand router per D6. `add`: echo-off TTY prompt or piped stdin; refuses — each
with a distinct named reason — a provider with no `authEnv` declaration, a
`credentialMode: "passthrough"` provider, and an `envName` outside the declared name +
`curatedEnvNames()`; prints the §2.3 threat-boundary text verbatim; `--check` opt-in. `list`:
never the secret; columns provider/id/source/fingerprint/added/rotated/expiry/status; masking from
the fingerprint. `rotate <id>`: refuses (non-zero, nothing cleared) when the winning source for
that provider is not the keystore, naming the shadowing variable; on success clears
`breaker.clearCredentialFaults(credentialId)` + `clearFacts(…, { kinds: ["credential-invalid"] })`
narrowed — `allowance-exhausted`/`not-servable`/`subscription-required` stay intact, with the
"verified operator assertion" code comment the design requires. `revoke`: sets `revokedAt`, keeps
the row. `remove --purge`: says plainly that overwrite-then-unlink is theatre on journaling
FS/SSD. `export`: encrypted only (scrypt + AES-256-GCM, passphrase typed at export time);
plaintext export does not exist. `import`: accepts the encrypted export and the plaintext
freellmapi envelope + dotenv (reusing `parseCredentialImport`), destination the keystore.
`unlock`: passphrase mode only. `classifyCommand` + `VALUE_FLAGS` entries. Docs: `docs/reference.md`
custody section (threat boundary, lifecycle, coexistence), CLAUDE.md table rows for the two new
modules + a custody gotcha, README one-liner.

Tests: every refusal (named reasons, exit 1, `test/cli.test.ts` exit-mock pattern); rotate
clearing narrowness; rotate/add shadow refusal; list/export never carry a secret (leaks helper);
import round-trips both formats; unknown subcommand fails loudly.

## 4. Compatibility contract

Design §6 items 1–11 bind this sprint verbatim — most load-bearing here: a config with no keystore
behaves identically; `credentialState` keeps three values; env keeps winning; no new HTTP surface
and the tokenless set stays at five; nothing new spawns on the request path (the keyring is
touched at unlock/first-resolution, and the request path reads memory).

## 5. Verification and release

- Gate per packet: `npm run build && npm run check` on a clean committed tree; adversarial review
  (fresh-context reviewer) per packet, findings fixed and pinned before the next packet.
- Windows live smoke after Packet 3, on THIS machine (the only place DPAPI is real): scripted
  round-trip against a SCRATCH store path — wrap KEK, add, list, rotate, unwrap after a fresh
  process start — never touching `~/.llm-relay/keystore.json` until the operator migrates by hand.
- Release: `/release` skill, v0.45.0, after all three packets + reviews. Migration of the owner's
  12 live keys is an OPERATOR action after release, not part of the sprint.

## 6. Lane plan

Implementation: `codex exec --model gpt-5.6-sol --config model_reasoning_effort=ultra` (the proven
write lane; M4/M3 precedent). Commit trailer: `Co-Authored-By: GPT-5.6 Sol (Codex)
<noreply@anthropic.com>`. Review: native Opus, fresh context, adversarial. Judgement and
integration: this session. Lanes are told to decide and proceed, never to stop and ask (HANDOFF
§4), and never to push — push happens at sprint close after review.
