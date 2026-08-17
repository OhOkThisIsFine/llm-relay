# Credential fleet design — custody, pooling, cost accounting (2026-08-16)

Owner-scoped on 2026-08-16: **metering + local key custody + multi-key pooling**, serving all four
purposes (observability, enforcement, routing input, cost accounting). Produced by three parallel
designs merged under two adversarial reviews (security, engineering).

Companion documents: [rubric-recalibration-2026-08-16.md](rubric-recalibration-2026-08-16.md)
(why these were rejected and what voided the reasons) and
[quota-metering-spec-2026-08-16.md](quota-metering-spec-2026-08-16.md) (the tracking pipeline).

**Budget: zero new runtime deps, no native module, no database.** The one real restriction is that
the JSON counter store is single-writer by construction — documented, not hidden.

---

## 0. What this document is

One design for three things the owner scoped together — **local key custody, multi-key pooling, and cost accounting** — plus the Stage 0 refactor without which none of them can work. Where the three input designs conflicted I resolved against source and say which won. Where an adversarial finding was decisive it is folded into the design body, not listed as a caveat. Findings I judged wrong are named in §9.

Invariants still in force and untouched by everything below: loopback-only bind; logs are metadata-only; the repair boundary (no LLM judgment on the request path); destructive calls refused, never fabricated; health DEMOTES rather than drops.

---

## 1. Data model

### 1.1 The one model

Four entities, and the whole design turns on keeping them distinct:

| Entity | Identity | Persisted where |
|---|---|---|
| **Provider** | `nim` — a base URL, a kind, a header, a credential policy | `config.json` |
| **Credential** (slot) | `nim#personal` — an *account* with a key in it | declared in `config.json`, secret resolved at attempt time |
| **Deployment** | `nim/z-ai/glm-5.2` — a (provider, model) pair | derived; the existing `ResolvedTarget` |
| **Attempt** | `nim#personal/z-ai/glm-5.2` — one cell of the cube | in-memory breaker state + the usage ledger |

### 1.2 Credential identity — resolved definitively

**`CredentialId = "<provider>#<label>"`. The identity is the SLOT, not the key material and not the storage location.**

Design 1 proposed `keystore:k_7f3a…` / `env:NVIDIA_API_KEY`. That grammar is derived from *where the secret is stored*, so moving a key from an env var into the keystore changes its identity and resets every quota counter, every health cell and every accounting row attached to it — at exactly the moment the owner is doing a migration and most wants continuity. Design 2's slot identity wins, and the engineering review is right that both designs keying load-bearing state off two different grammars is itself the defect.

Deriving the id from a hash of the secret is also rejected: it is a weakened secret in every log line, and it resets all history on rotation.

**Why the keying cannot drift.** Three rules, each mechanical rather than a matter of discipline:

1. **One definition.** `CredentialId` is minted by exactly one function in one module (`credential-id.ts`), which everything else imports — the breaker, the fact store, the usage ledger, the log field, the response header. This is the precedent `src/target-facts.ts:149-157` records: `FACT_KINDS` is *derived* from `FACT_TTL_MS` because a hand-maintained copy already fell behind once (`rate-limited` existed in the store while the CLI rejected it). A test enumerates the grammar from that one definition.
2. **Always present, never optional.** A single-slot provider gets the implicit label `default`, so the key is `nim#default/z-ai/glm-5.2` and there is no second key shape to fall back to. `getKey`'s existing modelless branch (`src/circuit-breaker.ts:167-170`, which emits a bare `provider`) becomes a bare `provider#label`.
3. **Required parameters, not optional ones.** Every scope-aware function takes `credentialId: string | null` as a **required** argument. `null` is documented as "matches no credential-scoped fact" — fail-closed. Making it required breaks the typecheck at every call site, forcing each to be triaged deliberately. That is exactly the mechanism `tsconfig.test.json` is credited with in CLAUDE.md when it found hand-built literals missing a required field.

### 1.3 The credential-as-scope question — resolved

**Not a new axis. The existing `provider` scope was mis-named, and multi-key is what makes the naming error observable.**

`src/target-facts.ts:76-78` already documents provider scope as: *"every deployment behind that credential. Balances, revoked keys, account rate limits."* The word in the source is **credential**. It was named after the provider only because the two were 1:1.

Scopes go from four to six, resolved most-specific-first:

| scope | covers | typical kinds |
|---|---|---|
| `attempt` (provider, credential, model) | one cell | per-key entitlement wall, "not found for this account" |
| `group` (provider, credential?, members[]) | explicit member list — unchanged discipline | reviewed family verdicts |
| `deployment` (provider, model) | all credentials | model de-listed at this provider |
| `credential` (provider, credential) | all models | balance, revoked key, account rate limit, plan gating |
| `provider` (provider) | all credentials, all models | endpoint outage, roster-wide removal |
| `model` (model) | cross-provider, reference-grade only | unchanged |

Precedence: `attempt → group → deployment → credential → provider → model`. `deployment` and `credential` are genuinely incomparable, so the tie-break is stated rather than implied: the deployment fact is stated about a *model*, and model identity is the more stable axis — a key rotates, a model id does not. This ordering also leaves every single-credential install byte-identical to today.

The evidence rule at `src/target-facts.ts:23-28` — scope comes from evidence, never from counting — is unchanged and now has two more ways to be right. The proposal surface stays a closed enum (6 scopes, no free text), so the containment that makes an agent reading an untrusted error body safe is preserved.

### 1.4 Migration — the reviews are right, and "migrate" was the wrong word

Design 2 said existing `{kind:"provider"}` facts "migrate to `credential`". **That migration is not constructible.** A stored provider-scope fact records `{kind:"provider", provider}` (`src/target-facts.ts:83-87`) and carries no credential, because when it was written there was only one. You cannot narrow a fact to a credential it never named.

Worse, `load()` does no schema validation — it accepts `parsed.facts` and casts (`src/target-facts.ts:194-200`) — so on upgrade every existing `p:` entry keeps loading and is silently reinterpreted under the *new*, wider meaning. That is the widening direction, which demotes capacity never proven bad.

**Resolution: bump to `version: 2`, reject a v1 document, and drop every `p:`-keyed fact on load,** with the reason in the docstring. The store already documents that everything in it is re-learnable and the worst cost is one wasted round-trip (`src/target-facts.ts:204-206`) — that is precisely the price of narrowing, and narrowing is always the safe direction.

Accepted refusal interpretations get the same treatment: a persisted `{kind:"provider"}` template is **re-presented for acceptance** under the new enum rather than auto-rewritten. A verdict whose blast radius changed is a new verdict, and only the user may accept one.

`SEED_INTERPRETATIONS` needs re-triage in the same commit — "not found for account" is `attempt`, "model does not exist" is `deployment`, "your account has no credits" is `credential`.

### 1.5 Health keying — free, because breaker state is in-memory

The breaker key becomes `provider#label/model`, stored at the **finest observable grain**, with every coarser answer computed as an aggregation. One store, two read granularities.

- `isHealthy` / `hasCredentialFault` / `cooldownUntil` → read **that cell only**. Correct because 429, 402, 401 and 403 are all metered or asserted per credential.
- `getMeasuredStability(target)` / `hasObservations(target)` → **merge across credentials**, because latency and uptime are properties of the deployment; key #2 does not make a model faster.
- `clearProviderCredentialFaults(provider)` (`src/circuit-breaker.ts:496-523`, currently a prefix match on `provider/`) becomes `clearCredentialFaults(credentialId)` with prefix `provider#label/`. Its caller — a **stated** `credential-invalid` just disproved, never a bare success — passes the succeeding attempt's id.
- `applyHealthOutcome`'s success branch clearing `credentialFailures`/`credentialFaultUntil` (`src/circuit-breaker.ts:424-425`) now clears only the succeeding cell. Strictly more correct than today.

**This costs no migration.** `CircuitBreaker` holds `private states = new Map<…>()` and the file contains no `readFileSync`, `writeFileSync`, `persist` or `WriteBehind` — verified by grep. Breaker state is process-local and rebuilds on restart, so re-keying is a pure code change.

Storing at the finest grain and aggregating upward is what makes drift *structurally* impossible rather than a discipline to maintain — the direct application of the lesson `src/target-facts.ts:6-29` records.

**But the merge must not launder confidence** (engineering review, correct). `stabilityConfidence` is `Math.min(1, samples.length / 5)` (`src/dynamic-pools.ts:49`) and `MAX_PING_HISTORY` is 10 per cell. A deployment probed once under each of five credentials would report five samples and *full* confidence — five single observations of five different accounts presented as one confident measurement, which violates the surviving "never present an estimate as an observation" invariant in exactly its recalibrated form. So: **merge the central tendency, derive the confidence from the minimum per-cell sample count**, and sort the merged window by timestamp before any percentile (the merged array is a concatenation of per-cell FIFOs and is not otherwise time-ordered).

---

## 2. Custody

### 2.1 Mechanism — envelope encryption with an OS-held KEK

One random 256-bit KEK per store, wrapped by the platform. Each secret is AES-256-GCM under the KEK with `authTagLength` pinned to 16 (Node otherwise accepts 4–16 byte tags per RFC 5116 §3.2 — a truncation-forgery path freellmapi already closed in `server/src/lib/crypto.ts:181-186`).

**AAD = `${version}|${provider}|${entryId}`.** freellmapi's `api_keys` rows have no AAD.

Platforms:
- **Windows (primary):** DPAPI CurrentUser via `Add-Type -AssemblyName System.Security` → `[ProtectedData]::Protect`. Target **Windows PowerShell 5.1 by absolute System32 path**, never off `PATH` — the same rule `winenv.ts` and `secret-file-acl.ts` follow for `reg`/`icacls`, and the reason is that a Git Bash shim on `PATH` shadowing the binary that handles your secret is itself a hijack vector. Do **not** target pwsh 7: its `ProtectedData` is a NuGet-sourced assembly, a property of that distribution rather than a framework guarantee.
- **macOS:** `security add-generic-password` / `find-generic-password -w`. One keychain item (the KEK), so one prompt per unlock.
- **Linux:** `secret-tool` if present, else a scrypt-derived KEK from a passphrase prompted at `llm-relay keys unlock`. **If neither is available, refuse to store** and tell the user to keep using env vars. Never write an unwrapped KEK beside the ciphertext — that is exactly the model this design exists to beat, and a silent downgrade is worse than not shipping.

### 2.2 The KEK must cross the process boundary over stdin — not argv

Decisive security finding, folded in as a hard requirement.

An argv-borne KEK lands in five places at once: `Win32_Process` command lines readable by any process running as this user; EDR/Sysmon process-create telemetry; PowerShell ScriptBlock logging and Transcription (both GPO-enablable); and — worst — the `Error` thrown by `execFileSync`, whose `.message` embeds the full argv and whose `.stderr`/`.output` hang off the same object. That error then reaches `src/process-safety-net.ts:124`, `log(\`llm-relay: fatal ${kind}:\`, err)`, which `console.error`s the **raw error object** to the relay's stderr. The classifier at `:86-88` routes anything non-transport down that path, and a crypto/keyring failure is non-transport by construction.

Design 1 correctly forbade argv for the user's secret in `keys add` and then never applied the same rule to the KEK — the material that unlocks all N secrets.

Requirements:
- KEK bytes travel over **stdin/stdout only**: `execFileSync(ps, ['-NoProfile','-NonInteractive','-Command','-'], { input: blob })`.
- Inside the script, read/write via `[Console]::OpenStandardInput()` / `OpenStandardOutput()` raw streams — never `Write-Output`, because Transcription hooks the host output pipeline.
- Every spawn in the keyring/keystore modules is wrapped so **no child_process error escapes**: catch and rethrow a fresh `Error('keyring unwrap failed')` carrying none of the child's `.message`/`.stderr`/`.output`/`.cmd`. Pinned by a test asserting the rethrown error's serialization contains neither the argv nor any child output.

### 2.3 The honest threat boundary

Stated precisely, and printed verbatim by `llm-relay keys add`:

- **What it stops:** a copy of `keystore.json` alone — committed to a repo, synced to cloud storage, pulled from a partial backup, or moved to another machine — is useless.
- **What it does not stop:** a copy of the **whole user profile together with the account password**. `%APPDATA%\Microsoft\Protect` travels in a whole-profile backup, and an offline attacker holding it plus the password (or its hash, or a domain backup key) decrypts CurrentUser blobs. This is routine, not exotic.
- **What nothing user-side stops:** code already running as you.

Design 1's phrasing — "there is no key file at all", "lifted out of a backup is undecryptable" — is overstated and is corrected here. The DPAPI master key *is* a file, in the same profile; what changes is that it is wrapped by the logon credential. That remains a strict improvement over a master key sitting beside the ciphertext, and saying so precisely costs nothing.

Two more honest limits:
- ⚠ **Measured, do not re-derive:** `ProtectedData.Unprotect(blob, null, 'LocalMachine')` on a `CurrentUser`-protected blob **succeeds**. The scope argument is not validated on unprotect; the blob carries its own scope. Do not treat passing it as a safety check.
- An **admin-forced password reset** on a non-domain machine destroys the DPAPI master key and every entry becomes undecryptable. A normal password change is fine.

**What the AAD actually buys** (narrower than Design 1 claimed, and still worth keeping): an attacker who can write the keystore runs as this user and can therefore also unwrap the KEK and re-encrypt under the correct AAD. What the AAD closes is a writer who has **not** unlocked the KEK — a restored backup, a file-sync service, a repo checkout, a torn write, an operator hand-edit.

**The envelope form's cost, stated rather than hidden:** the KEK sits unencrypted in the heap of a process that runs for days, and `readCredential` returns a JS `string`, so every decrypted secret is an immutable, un-zeroable, GC-lifetime heap object. Against the one adversary DPAPI cannot exclude, envelope encryption is *not* strictly stronger than per-secret protect — it trades a shorter plaintext lifetime for one fewer process spawn. It is still the right choice (one spawn, one file format, ~40 platform-specific lines), but: hold the KEK in a `Buffer` and `fill(0)` on re-lock; do **not** cache decrypted secrets keyed by provider; and document that the relay must never be launched with `--heapsnapshot-signal`, `--report-on-fatalerror`, or `--inspect`.

### 2.4 Store format

`~/.llm-relay/keystore.json`, versioned JSON with degrade-to-fresh, following `src/target-facts.ts:167-180` — **including the `VITEST` path redirect at `:170-172`**, so a test can never write into the user's live keystore.

```jsonc
{
  "version": 1,
  "kek": { "wrap": "dpapi"|"keychain"|"libsecret"|"passphrase",
           "blob": "<base64, dpapi only>",
           "kdf": { "n": 16384, "r": 8, "p": 1, "salt": "<b64>" } },
  "fpSalt": "<b64, 32 bytes>",
  "entries": [{
    "id": "nim#personal",              // the CredentialId — AAD-bound
    "provider": "nim",
    "envName": "NVIDIA_API_KEY",
    "ct": "<b64>", "iv": "<b64>", "tag": "<b64>",
    "fingerprint": "hmac:ab12cd34",
    "addedAt": …, "rotatedAt": …, "expiresAt": …, "revokedAt": …, "disabled": false
  }]
}
```

**`fingerprint` is an HMAC, not a bare digest.** Design 1 specified a truncated SHA-256 *of the secret*, displayed in `list` and declared loggable — which is an offline verifier for that secret, derived from the secret's own bytes: exactly the objection Design 1 correctly raises against freellmapi's `maskKey` (`crypto.ts:198-201`, which prints eight real characters into scrollback). It is weaker than `maskKey` against a human reader and stronger against a machine one, which is the wrong way round. Use **HMAC-SHA256 under the KEK**, truncated to 8 hex: identical utility for "is this the same key as `$NVIDIA_API_KEY`" (that comparison is computed in-process) and unusable without an unwrap.

**Charset validation on both `id`/label and `envName`, at write AND at load** — label `^[A-Za-z0-9_.-]{1,32}$`, envName `^[A-Za-z_][A-Za-z0-9_]*$` (matching `parseDotEnv`'s own name test). These values reach CLI output, the `x-llm-relay-credential` response header and a log field; Node rejects CR/LF in header values with `ERR_INVALID_CHAR`, so an unvalidated label is a 500 on every request that credential serves, plus a terminal-escape vector in `keys list`. A malformed entry is **dropped** on load under degrade-to-fresh, not accepted.

### 2.5 Coexistence with env vars — and the correction that makes custody actually work

Precedence, extending the existing contract:

1. `process.env` — the real environment
2. `~/.llm-relay/.env` — already merged into `process.env` at startup by `src/dotenv.ts:53-75`
3. `~/.llm-relay/keystore.json` — **new**

Fallback, not opt-in: `src/dotenv.ts:9-12` and `src/winenv.ts:16-19` both state the same contract (the real environment wins because it is the more explicit signal), and an opt-in store would create a fourth state — "stored, present, and deliberately not used" — reproducing the exact bug `dotenv.ts` was written to fix.

**⚠ Design 1's central claim here is wrong, and both reviews caught it independently.** Design 1 said `readCredential()` should delegate to a new resolver while `credentialState` keeps its current shape. But `credentialState` is what decides **admission**, in two places that run before any header is built:

- `src/config.ts:729` — `targets.filter((t) => credentialState(t.authEnv) !== "declared-missing")`
- `src/server.ts:2632-2637` — throws `CredentialConfigError` on `declared-missing`

A provider whose key lives only in the keystore is therefore `declared-missing`, gets dropped from routing, and if routing lets it through the request fails with a credential-config error. **The store would be correctly built, correctly unwrapped, and never consulted.** The feature does not work for its primary case.

**Resolution:** keep the three-valued `CredentialState` — that part of Design 1's argument is right, and adding a `stored-present` value would force re-auditing every `state !== "not-declared"` test while answering a *containment* question that storage location does not change. But route the **presence test** through the same resolver as the value:

```ts
resolveCredential(declared, env, provider)
  → { value, source: "env" | "env-file" | "keystore" | "none", credentialId }
```

`credentialState`, `readCredential` and `keyIsPresent` all derive from that one return. No caller consults `process.env` directly. **Resolve once per request and thread the result down**, so a passphrase-mode lock expiring between two calls cannot flip state mid-request. `source` is a **provenance label, never a decision input** — the recalibrated guess rule applied to origin.

**⚠ The store must NOT be merged into `process.env`.** That environment is inherited by every child the relay spawns — `lane-probe.ts`, `reg`, `icacls`, and `powershell.exe` for the unwrap itself. Decrypting a key to protect it and then broadcasting it to subprocesses is self-defeating. It would also destroy the provenance the CLI needs to explain why a rotation did not take effect.

### 2.6 Lifecycle

- **`add`** — secret never on argv (shell history plus a visible process command line). TTY prompt with echo off, or piped stdin. Store immediately; `--check` is opt-in, because `validateProviderKeys` is slow (90 s per-provider budget) and a failed check must never block persistence — `unverified` exists precisely so the check can decline to conclude.
  **Validated against the loaded config**, refusing with a named reason when: the provider declares no `authEnv`; the provider resolves to `credentialMode: "passthrough"`; or `envName` is neither the declared name nor a curated alias from `curatedEnvNames()`. Without this, `llm-relay keys add anthropic` is accepted, shows in `list` as configured, never serves, and the passthrough goes on forwarding the caller's own token — while the operator believes a contained key is in use. The tempting "fix" (attach a stored key whenever an entry exists) silently converts a declared passthrough into a contained provider, which is the inversion `src/authEnv.ts:89-96` exists to warn about.
- **`list`** — never the secret. Columns: provider, credential id, source (`env`/`env-file`/`keystore`), fingerprint, added/rotated, expiry, last-known status, headroom band. Masking is from the fingerprint, never from the secret's bytes. Says which process answered (a CLI process's env is not the relay's).
- **`rotate <id>`** — new ciphertext, same id, set `rotatedAt`, then clear the credential-fault state the old key produced: `breaker.clearCredentialFaults(credentialId)` and a **narrowed** `clearFacts(provider, credentialId, { kinds: ["credential-invalid"] })`.
  ⚠ The narrowing is load-bearing: unfiltered, `clearFacts` deletes every condition covering the deployment, which on rotation would also clear `allowance-exhausted` — but a new key on the **same free account** has the same spent allowance, so the relay would immediately re-probe an exhausted lane. That is the "out of free credits is NOT paid" failure named in CLAUDE.md. It would also clear `not-servable`, which a rotation does not fix.
  ⚠ **`rotate` and `add` REFUSE (non-zero exit, nothing cleared) when `resolveCredential` reports the winning source for that provider is not `keystore`**, naming the shadowing variable and its file. Otherwise the rotation changed nothing on the wire while deleting the learned `credential-invalid` fact and every per-deployment 401 — the relay then re-probes the same dead key, re-learns the fault per model on a 15-minute TTL, and the pool narrows, widens and narrows again with no explanation. This also removes the need to decide whether to edit the user's `.env`: the shadow becomes a one-line error instead of a silent no-op.
  With that check in place, rotation-triggered clearing is a defensible widening of the "only on a disproved **stated** fact" rule (`src/target-facts.ts:352-356`, `src/circuit-breaker.ts:505-509`) — the operator's assertion has been verified against what actually resolves. Say so in the code comment; do not slip it in.
- **`revoke <id>`** — set `revokedAt`, **keep the row**. Deleting it leaves an unexplained keyless provider.
- **`expire`** — `expiresAt` is *declared*, never inferred from age. On expiry the entry stops resolving, `list` says so, and the provider degrades via `Config.warnings`; it never aborts startup.
- **`remove --purge`** — say plainly that overwrite-then-unlink is theatre on a journaling FS or SSD. Do not claim secure erase.
- **`export`** — **encrypted only**: scrypt-derived key from a passphrase typed at export time + AES-256-GCM (reusing the Linux passphrase mode). Design 1's plaintext v1-envelope export, made a *precondition of storing anything* by its open question 6, would guarantee a plaintext bundle of all 12 keys exists in the same profile before the first key ever serves — negating the one property the design is built on and landing in the same whole-profile backups it uses to indict freellmapi. Export stays an on-demand command. `import` accepts both the encrypted form and the plaintext freellmapi envelope (someone else's format, not one we author).
- **`unlock`** — passphrase mode only; no-op elsewhere.

### 2.7 No secret-bearing HTTP endpoint

Stated explicitly, because the CLI's `tryServer` pattern pulls hard toward adding one (the serving process may hold unwrapped keys a fresh CLI process does not).

The existing admission function (`src/server.ts:110-153`) fully covers the CSRF class. But the control token does not cover the threat DPAPI also cannot cover: it is a 0600 file in the same profile (`src/control-authorization.ts:28,181`), readable by any process running as this user. A mutating credential endpoint would hand every local process a remote-controlled path to add, rotate and read keys.

Therefore: **`add` / `rotate` / `export` / `unlock` are CLI-local only** — file plus OS keyring, no HTTP. The server's surface is read-only metadata on the already-token-gated `/registry` and `/candidates`, plus at most a bodyless `POST /keys/reload` returning `{reloaded:<count>}`. If the CLI needs the serving process's view, it reads `/candidates`.

### 2.8 Import

- **From env** — walk `curatedEnvNames()` (`src/authEnv.ts:42-44`) per configured provider. The narrow surface. Never `candidateEnvNames`, never a scan.
- **From a `.env` file** — existing `parseDotEnv`, destination the keystore. Offer to blank the source, and be honest that its old contents survive in backups and unallocated blocks.
- **From freellmapi — manual only.** Design 1 recommended automating `GET 127.0.0.1:3001/api/keys/export?format=json`, stating it "requires an `x-reauth-password` header unless `skipsReauth(req)`". That is only half the gate: `app.use('/api/keys', requireAuth, keysRouter)` (`C:\Code\freellmapi\server\src\app.ts:226`) puts the whole surface behind a **session**, and `skipsReauth` (`routes/keys.ts:380-382`) waives only the password re-verification, not the session. Automating it would make llm-relay acquire, store and refresh *another local service's* session bearer token — a second credential to custody, created to migrate 12 keys once.
  **The manual path works today with zero new code:** export from the freellmapi dashboard to a file, `llm-relay keys import <file>`, shred the file. `parseFreeLlmApiExportJson` (`src/key-import.ts:76-99`) already consumes that exact envelope and reports provider and env names, never values.
  Route B (direct `freeapi.db` read) is rejected: it needs `better-sqlite3`, killing the two-runtime-dep property, and the DB is WAL-mode so a naive read misses committed rows.

### 2.9 File hardening

`src/secret-file-acl.ts` already gives: inherited-ACE removal via an `icacls` **argv array**, best-effort posture (spawn errors swallowed, `:52-57`), and a `VITEST` guard (`:42`). Three gaps, each already solved better in freellmapi's `file-permissions.ts` — port them:

1. **Grant by SID, not name.** `%USERNAME%` is a localized display name that can collide with a domain principal; resolve the owner SID via `whoami /user /fo csv /nh`.
2. **Retain SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`).** `/inheritance:r /grant:r user:F` drops them, which breaks backup agents for no security gain — both can take ownership anyway. POSIX 0600 never locks root out either.
3. **A sync variant for create-time hardening.** The current `spawn(...).unref()` (`:47-51`) is fire-and-forget, so there is a window where the file exists under its final name with inherited ACLs. Use tmp→restrict→rename — **which already exists correctly in-tree** at `src/control-authorization.ts:130-153` (the temporary file is restricted at `:144` *before* `linkSync` at `:147`). Copy that sequence.

Plus: directory hardening with `(OI)(CI)` so `.tmp-*` siblings are born restricted, and resolve `icacls` from `%SystemRoot%\System32` absolutely — the same argument the design makes for `powershell.exe` applies unchanged to a binary handed the keystore's own path. Note that `chmodSync(0o600)` is a **silent no-op for ACL purposes on Windows**, so on the primary platform the ACL call is the only real protection.

### 2.10 Availability posture (non-negotiable)

A keystore that cannot unwrap — roaming profile, restored backup, forced password reset, missing keyring daemon — **degrades the providers it covers with a `Config.warnings` entry and never refuses to boot.** This is `src/config.ts:1007-1017`'s rule applied to a new failure class: the proxy fronts every client session, so one unreadable optional store must never become a total outage.

---

## 3. Pooling

### 3.1 Declaration

`authEnv` stays exactly as-is (the one-key form, unchanged). A new optional sibling:

```jsonc
"nim": {
  "base": "...", "kind": "openai", "authHeader": "authorization",
  "credentialMode": "contained",
  "credentials": [
    { "label": "personal", "authEnv": "NVIDIA_API_KEY" },
    { "label": "work",     "authEnv": "NVIDIA_API_KEY_WORK" },
    { "label": "spare",    "authEnv": "NVIDIA_API_KEY_3", "enabled": false,
      "models": ["z-ai/glm-5.2"] }
  ]
}
```

Every entry names an **env var NAME**, never a key. `credentialMode` stays per-provider: a multi-key pool is one credential-handling policy, and containment is about who the *host* is.

**No per-credential `base`.** Design 2 declined per-key proxy overrides and then recommended a per-credential `base` — an egress-redirect primitive sitting directly on a stored credential, which Design 1's AAD (provider + entryId) does not bind, so the stored NVIDIA key would be sent to whatever host the base names. `src/config-edit.ts:78-93` makes `providers.nim.credentials.2.base` a supported single-command edit. This reintroduces through config exactly the leak `src/authEnv.ts:10-13` refuses to create through inference. A different endpoint is a different provider — which is what the provider map is for. Design 2's own reason for declining per-key proxies applies verbatim.

**Alias resolution applies only to the single-credential form.** With N slots, `resolveAuthEnv`'s curated fallback could make two slots resolve to the same env name — one key counted as two quota domains, the precise failure this feature exists to prevent. So N > 1 ⇒ declared names verbatim.

**Config errors degrade, they do not abort.** `authEnv` + `credentials` together is a hard error (two stated intentions, same reasoning as `credentialMode: "passthrough"` + `authEnv` at `src/config.ts:1027-1033` — a typo with a *credential* consequence). But a duplicate env name or a bad label **disables the offending slot with a `Config.warnings` entry** and keeps the provider serving on its remaining slots. That matches the established posture: an unset `${ENV}` disables one provider with a warning (`:1004-1017`), and the `credentialMode` inference case warns rather than throws (`:1038-1046`) precisely because refusing to start turns a hardening step into an outage. A duplicate slot name is a typo, not a leak.

Also fixed in the same change: the latent `authEnv: ""` + `credentialMode: "passthrough"` inconsistency — the guard at `src/config.ts:1020` requires `trim().length > 0` while the spread at `:1057` fires on `typeof p.authEnv === "string"`. Latent today only because resolution is frozen at load; §3.2 makes it live.

### 3.2 Addressing, and attempt-time resolution

**The routing spec stays `provider/model`. Credentials are not addressable in a spec.** A credential is a *resource*, not a destination; making it addressable invites configs that pin a key and defeat pooling. Mechanically it is also impossible: `provider/model` is already ambiguous with slashes in model ids (`nim/z-ai/glm-5.2`), so a third positional segment cannot be parsed — and `pool/<name>`, `routing.tiers`, `@relay:`, `/candidates`, dispatch `{spec}`, sticky pins and the tier-data join all key on `provider/model`.

New attempt-level type:
```ts
interface ResolvedAttempt { target: ResolvedTarget; credentialId: CredentialId; authEnv: string }
```
`ResolvedTarget` is unchanged. Both candidate loops iterate attempts where they iterate targets today. The escape hatch for a deliberate pin is an optional `credential: "nim#work"` **field** on a pool policy or offload rule — never a spec segment.

**⚠ Attempt-time resolution is refinement-only.** Moving resolution from load time (`src/config.ts:1054-1059`) to attempt time closes the documented `winenv` gap, but admission still happens at load. So the invariant: attempt-time resolution may choose among the slots a **load-time-admitted** provider declares, and may pick up a key that appeared after startup, but it must **never** resurrect a provider disabled at load nor a target `resolveTargets` dropped. `winenv.ts` stays as the startup backstop.

### 3.3 Selection — a named lexicographic gate ladder, not a score

**Stage 1 — eliminate:** `disabled` · `no-secret` · `model-scoped-out` · credential-scoped `not-servable` / `subscription-required` covering this model.

⚠ **With a survivor guard.** Elimination applies only while at least one credential for that provider survives; if it would empty the set, all are demoted to the bottom of Stage 2 instead, with the reason surfaced. Without this, a single mis-learned credential-scope fact — and under the new keying one poisoned refusal body can now produce an account-wide verdict where before it could only reach one (provider, model) — makes the provider vanish and a pool empty. This mirrors `src/config.ts:729-732` exactly (`if (activeTargets.length > 0) targets = activeTargets`) and avoids repeating the `filter(isHealthy)` bug CLAUDE.md records as "health demotes, never drops".

**Stage 2 — demote, never drop:** `cooling` (breaker cooldown on this cell, or credential-scope `allowance-exhausted` / `rate-limited`) · `credential-fault` (401/403 on this cell) · `budget-spent` (RPD/TPD bucket exhausted) · `concurrency` (no lease).

**Stage 3 — order the survivors:**
1. **headroom band** — `ample` / `tight` / `spent`, a coarse band, not a percentage. Bands because the inputs are mixed evidence: ordering on a raw number would let a measured 61% and an estimated 60% swap places, i.e. an estimate deciding a routing outcome against an observation. The band travels with its basis.
2. **cost class** — `assessCost` free → paid → unknown, the same function `src/dynamic-pools.ts:258-266` uses. `unknown` sits with paid.
3. **least-recently-used** — deterministic round-robin tie-break.

freellmapi's Thompson-sampled `orderKeysByScore` (`router.ts:1062-1079`) is deliberately **not** adopted: a randomized draw is unreproducible by construction.

**Interleaving.** Pool arrays stay provider-interleaved as they are today — that decision is made once at materialization and is unchanged. The credential dimension expands in **rounds** at attempt time: one credential per provider in round 1, so the first N attempts still cover N *quota domains*; a second credential on the same provider is reached only after a failure that is credential-attributable (401/403/402/429), never after a 5xx or a timeout, which say nothing about the key. This preserves the property that pool ordering interleaves providers within a rank band rather than clustering behind one credit balance.

### 3.4 Concurrency leases — on the existing lifecycle, not a second one

freellmapi's per-key lease (`ratelimit.ts:126-146`, gated at `router.ts:1120-1123`) exists because parallel streams all pick the same key and 429 each other on providers that meter concurrency per credential. llm-relay's walk is sequential per request but it serves concurrent requests, so this bites today with one key and harder with N.

**Do not build a second lifecycle.** `CircuitBreaker` already implements `AttemptLifecyclePort` with a branded begin/complete handshake (`beginAttempt` at `src/circuit-breaker.ts:184-200`, completion at `:320-350`) which *is* a per-attempt resource lifecycle, and both request paths are already required to account through it. Hang the lease on the existing `AttemptHandle`: acquire inside `beginAttempt` **after** the gates clear (preserving freellmapi's rule at `router.ts:1194-1196` that a rejected candidate never consumes budget), release in the one place `completeAttempt` already runs, and make the non-completion path release too.

Every exit path must release: completion, upstream error, `discardCandidate` on failover, stall timeout, thrown `CredentialConfigError`, and — the one that will actually bite — a client disconnecting mid-SSE, which on this proxy is routine. A leaked lease is permanent capacity loss, and because `concurrency` is a Stage-2 *demote*, a fully leaked credential is not dropped but silently pinned to last resort forever: a slow capacity halving with no error and no log line.

**Leases are in-memory only and never persisted.** A lease that survives a crash pins capacity that no longer exists.

### 3.5 What selection reports

- **Wire:** `x-llm-relay-credential: nim#work` on served responses where the provider has >1 credential, and `x-llm-relay-credential-attempts: "3 tried, 1 served: 1×429, 1×credential-fault"` — same shape and same silence rule as `POOL_ATTEMPTS_HEADER`: a single-credential walk emits nothing, because the response already *is* the walk.
- **Log:** `servedCredential` added to `LOG_FIELDS` (`src/log.ts:68-93`). A `CredentialId` is an opaque slot name, not a credential, so it passes the metadata-only invariant — and the allow-list means it starts being logged only by a deliberate edit, which is the right friction. The **value** never is, under any flag.
- **CLI/control plane:** per-credential fields go on **`/registry` and `/candidates` only** — both already token-gated. `/telemetry` stays at provider granularity exactly as it is.
  ⚠ `TOKENLESS_CONTROL_READS` (`src/server.ts:77-83`) is `/v1/models`, `/models`, `/offload`, `/dispatch`, `/telemetry` — five routes that require **no capability token**, only Origin/Host admission, with an absent Origin deliberately allowed so the CLI works. Any local process reads them. Adding labels, headroom bands or spend there hands a local attacker a map of the fleet and its balances. Pin the tokenless set to its current five members with a test so a future endpoint cannot be added to it by accident.

Adopt freellmapi's **skip tally** (`router.ts:1128-1129, 1206-1207`) — a per-gate count of why each credential was rejected. It is what makes the ladder reportable, and it is the diagnostic `/candidates` is for.

### 3.6 `clearFacts` must take the credential explicitly

Design 2 claimed credential-aware clearing "falls out of the keying rather than being coded". **It does not**, because `clearFacts` and `covers` are called from paths that have no credential — `src/context-limits.ts:110` and several CLI paths. If the parameter is optional and absent matches *all* credential-scoped facts, a success on `nim#personal` clears a genuine `credential-invalid` on `nim#work` — the exact cross-key contamination the re-keying exists to stop. If absent matches *none*, credential facts become unclearable from those paths.

Resolution: `credentialId: string | null` is a **required** parameter of `covers`, `factsFor` and `clearFacts`, with `null` documented as "matches no credential-scoped fact" (fail-closed).

---

## 4. Cost accounting

### 4.1 What is counted

Per attempt: `input_tokens`, `output_tokens`, and a derived `costUsd`. Aggregated per `(credentialId, provider, model, UTC day)`.

### 4.2 Where the numbers come from — three rungs, each labelled

This follows `resolveMetadata` and `getStrength` exactly: an estimate may be used, it may never be *labelled* as a measurement.

| rung | basis | source |
|---|---|---|
| `reported` | the backend's own `usage` block | `assistant.usage` (buffered), `message_delta` (streamed) |
| `estimated` | this relay's chars/4 estimator | `estimateRequestTokens()` — input only; output has no estimator and stays `null` |
| `unknown` | nothing observable | `null`, never zero |

**Price** comes from `resolveMetadata()` unchanged — `pricePerMTokIn` / `pricePerMTokOut` with `priceSource: "provider" | "reference" | null` (`src/metadata.ts:76-88`). This rung already exists and already refuses to guess. A `null` price means `costUsd` is `null`, never `0`: `emitSse.ts:42-51` already establishes that `{output_tokens: 0}` asserts the call was free and is therefore a lie, and the same reasoning governs currency.

`costBasis` is the **weakest** of its inputs: `reported` tokens × `reference` price is `reference`-grade, not `provider`-grade.

### 4.3 The load-bearing problem nobody stated: the OpenAI front cannot see usage today

This is the largest single cost of cost accounting, and none of the three designs named it.

- **Anthropic path:** the SSE stream is accumulated into `acc` and `reconstructFromSse(acc)` already runs (`src/server.ts:2313, 2325`). Usage is recoverable — **except** on the `overflow` branch, where the accumulator cap is hit and `assistant` is `null`.
- **Buffered path:** `j.usage` is already read at `src/server.ts:2681`. Free.
- **OpenAI front, streaming:** `src/server.ts:1974-1980` iterates `upstream.body` and writes each chunk straight to the socket with **zero accumulation and zero parsing**. Usage is not observable there at all.

That is the exact "two paths, one policy empty" shape that produced the pool-failover incident and the context-guardrail gap, and shipping accounting on one front only would repeat it a third time.

**Resolution:** a shared, bounded **usage tail observer** — a small transform that scans passing chunks for the terminal usage event (`message_delta` / the OpenAI `usage` chunk), keeps at most a few KB of the trailing partial line, and writes to no client-visible state. It runs on **both** fronts, in the same place `observeAttemptHeaders` runs, and it must never throw and never delay a byte. Same discipline as the `{contextWindow}` learning loop, which CLAUDE.md already records as wired into both paths for this reason.

⚠ `res.clone()` is forbidden here — CLAUDE.md's standing rule. The observer is a pass-through transform on the single body, not a tee.

### 4.4 The lifecycle carries the number

`completeAttemptSuccess(h, attempt, status)` (`src/server.ts:1549`) currently carries **only a status**. Usage is added as an optional field on the completion outcome, so accounting flows through the one handshake both paths are already required to use. No parallel accounting call site — that is how the two fronts diverged before.

### 4.5 Attribution across failover, repair, cancellation and the degrade tail

The rule: **every attempt that reached a backend is accounted to the credential that made it, whether or not it served the client.** A pool that spends 13 round-trips to discover 4 facts spent real quota on 13 attempts, and an accounting model that only counts the winner is exactly the observability failure the owner reinstated metering to fix.

| situation | attribution |
|---|---|
| **Failover** — 12 failed, 1 served | 13 rows. Failed rows usually have `tokens: unknown` (an error body reports no usage), which is honest: the attempt happened, its token cost is unknown. Cost is `null`, not `0`. |
| **Repair** | The reshaper call is its **own** attempt row against the reshaper's own credential, `role: "repair"`. Rolled up separately, because "what did repair cost me" is a question the owner will ask and folding it into the request hides it. `FailoverReshaper` advancing on transport failure produces one row per candidate. |
| **Cancellation** (`completeAttemptCancelled`) | A row with `terminal: "cancelled"` and whatever usage was seen before the disconnect — typically partial output. Input tokens were spent regardless and are attributed. Never dropped: an aborted stream still cost the provider's input processing. |
| **Degrade tail** | The `x-llm-relay-degraded` label is carried onto the row. Otherwise the tail's cheaper spend is indistinguishable from the band's, and the whole point of announcing degradation is that a capability downgrade must not look like getting what you asked for. |
| **Client-side 4xx** (the statuses `src/circuit-breaker.ts` deliberately excludes from health) | Row written with `tokens: unknown`. Accounting and health are different questions and must not share an exclusion list. |

### 4.6 Storage — and the concurrency problem that JSON does not solve for free

The engineering review is right and this is the sharpest finding in either review.

The existing store pattern is safe for last-write-wins **state** and unsafe for read-modify-write **counters**. Every store caches the whole document on first read and never re-reads (`src/target-facts.ts:194-209`), and `persist()` serializes the entire in-memory document over the file (`:211-221`; identical in `src/ping/runtime-telemetry.ts:63-73`). There is no locking anywhere in the tree except the single `O_EXCL` create at `src/control-authorization.ts:137`. So the write granularity is the **whole file**, and the loser of a race loses every increment it made. This is not hypothetical: `llm-relay pools --probe` and `key-checker.ts` send real completions from CLI processes while the relay serves, and the CLI flushes the same stores on exit. For observability that is cosmetic; for **enforcement** it fails in the dangerous direction — under-counted spend means over-spend, silently.

**Resolution: single-writer plus an append-only journal.**

- **The serving relay process is the only writer** of `~/.llm-relay/credential-usage.json` (bucketed counters). Every CLI path is read-only. `pools --probe` and `keys --check` are **excluded from metering by construction** and say so in their output — a probe is not traffic the owner asked for, and pretending otherwise would put synthetic spend in the ledger.
- **The ledger is append-only JSONL** (`credential-usage.jsonl`), one line per attempt, opened `a`. Sub-`PIPE_BUF` line-atomic appends survive a crash and survive a second writer. The serving process compacts into daily rollups using the `O_EXCL` publish pattern already at `src/control-authorization.ts:130-153`.
- **The enforcement gate fails conservative** on a store whose last flush is unknown. "No counters found" is never "nothing spent".

### 4.7 Headroom — the `observed` rung already exists

`extractQuotaPercent` (`src/ping/ping.ts:26-52`) already parses seven `x-ratelimit-*` / `ratelimit-*` header variants, and `observeAttemptHeaders` already calls it on **both fronts** (`src/server.ts:714, 1836`) feeding `quotaPercent` into the breaker. The `observed` headroom rung is therefore live traffic-derived data that exists today and needs only credential keying.

Three rungs, matching §4.2's discipline:
- `observed` — the provider's own remaining/limit headers for **this credential**
- `counted` — the relay's own bucket count against a *configured* limit (a legitimate tunable default; it just must not be labelled `observed`)
- `unknown` — `null`, ordered neutrally, never a fabricated percentage

**Do not duplicate the cooldown ladder.** `RATE_LIMIT_ESCALATION_MS`, `QUOTA_EXHAUSTED_COOLDOWN_MS` and vendor `Retry-After` precedence (`src/circuit-breaker.ts:437-467`) are already better than freellmapi's, because they honour what the vendor stated. Only the keying was missing, and §1.5 fixes it. Skip freellmapi's `getCooldownDurationForLimit` entirely.

---

## 5. Dependency and complexity budget

**Plainly, what this costs:**

| | verdict |
|---|---|
| New runtime dependencies | **Zero.** `node:crypto` covers AES-256-GCM, `randomBytes`, HMAC and scrypt. |
| Native modules | **None.** |
| Storage engine | **None.** Two new JSON/JSONL files under `~/.llm-relay/`. |
| New subprocess invocations | **One class**, on the custody path only: an OS keyring binary (`powershell.exe` / `security` / `secret-tool`), invoked at most once per process at unlock. Same technique `winenv.ts` and `secret-file-acl.ts` already use. |
| New modules in `src/` | ~6 (`credential-id`, `credential-resolver`, `keystore`, `os-keyring`, `credential-usage`, `credential-select`) |
| Modules materially changed | ~10 |

**Is a database needed? No — and here is the honest accounting rather than a contortion.**

The case *for* SQLite is real: multi-process transactional increments are what `better-sqlite3` gives you in ~80 lines, versus ~150 lines of journal-plus-compaction. freellmapi used it for exactly these counters and was right to.

The case against, decisive here:
1. It is a **native module**, and this machine's system Node (26.x) has no `better-sqlite3` prebuild — the documented reason freellmapi runs on a pinned portable Node 22. A relay that fronts every client session cannot acquire a startup dependency on a toolchain-sensitive binding.
2. The workload is **one person's traffic**. Bucketed counters are O(windows), not O(requests). A JSONL ledger at ~10k lines/day rolls up into daily aggregates that a CLI report scans instantly.
3. The single-writer restriction is acceptable **because it is a restriction we can state**: the relay writes, CLIs read, probes do not meter. That is a design decision, not a bug being papered over.

**What we give up, stated so it is not discovered later:** no transactional multi-process increments; no SQL query surface for ad-hoc accounting slices. If the owner later wants arbitrary slicing across years of raw attempt rows rather than rollups, **that** is when SQLite earns its native module — and the JSONL ledger imports into it trivially. Adopting it now would be paying a toolchain cost for a query surface nobody has asked for.

**What genuinely grows in complexity, independent of storage:** the request path gains a second selection dimension (credential) inside an already-non-trivial candidate loop, and `server.ts` — already flagged by the advisory cognitive-complexity warnings — takes most of it. Mitigation: selection lives in `credential-select.ts` as a pure function over an explicit input record, so the loop calls one function rather than growing a nested loop. That keeps the ladder unit-testable without spinning a server, which is what makes the Stage-2 test plan tractable.

---

## 6. What must not break

The compatibility contract, in the order a user would notice a violation.

1. **A config with no `credentials` array behaves identically.** Single-slot providers get the implicit label `default`; nothing in routing, ranking, pool ordering or dispatch changes shape. Pinned by running the existing suite unchanged.
2. **A config with no keystore behaves identically.** `resolveCredential` returns `source: "env"` and every existing precedence rule holds. The keystore is a fallback rung; its absence is not an error.
3. **`process.env` and `~/.llm-relay/.env` keep winning.** A user who has never run `keys add` sees no change. A user who has sees a loud shadow warning, never a silent redirect.
4. **`credentialState` keeps three values.** No caller's `state !== "not-declared"` test needs re-auditing.
5. **The routing spec grammar is unchanged.** `provider/model` and `pool/<name>` parse exactly as before; no third segment is introduced anywhere.
6. **`/telemetry`, `/models`, `/offload`, `/dispatch` response shapes are unchanged**, and the tokenless set stays at five members.
7. **`LOG_FIELDS` grows by exactly one deliberate entry** (`servedCredential`). No log record widens implicitly; `test/log.test.ts` continues to pin the projection.
8. **Learned stores degrade, they never block.** A v1 `target-facts.json` loads clean, yields zero facts, and causes no provider-wide demotion. An unreadable keystore degrades its providers with a warning and the relay still boots.
9. **A single unavailable optional thing never becomes a total outage.** Missing keyring daemon, locked passphrase store, unreadable usage file, duplicate slot label — all degrade with `Config.warnings`. The only new hard error is `authEnv` + `credentials` together.
10. **Nothing new is spawned on the request path.** The keyring is touched at unlock; `--probe` remains the one place the relay runs a lane command.
11. **Response headers are additive and silent when trivial.** `x-llm-relay-credential*` appears only where a provider has >1 credential — a single-credential walk emits nothing, matching `POOL_ATTEMPTS_HEADER`.

---

## 7. Test plan

**Custody**
- A provider whose key exists **only** in the keystore survives `resolveTargets` **and** produces a populated auth header. (The Design-1 defect: without this, custody silently does nothing.)
- `credentialState`, `readCredential` and `keyIsPresent` agree on every source × present/blank/whitespace matrix.
- A keyring spawn failure's rethrown error, serialized, contains neither the argv nor any child stdout/stderr.
- The KEK never appears in any argv assembled by `os-keyring`.
- AAD binding: an entry whose `provider` field is edited fails to decrypt.
- Charset: a label or `envName` with CR/LF or a terminal escape is refused at `add` and **dropped** at load.
- `keys add` refuses a provider with no `authEnv`, refuses a `credentialMode: "passthrough"` provider, and refuses an `envName` outside `curatedEnvNames()` — each with a distinct named reason.
- `rotate` refuses and clears **nothing** when the winning source is not the keystore.
- `rotate` clears `credential-invalid` and leaves `allowance-exhausted`, `not-servable` and `subscription-required` intact.
- An unwrappable keystore degrades its providers with a warning and the relay still starts.
- Export is encrypted; a plaintext export path does not exist.
- The keystore's default path is redirected under `VITEST`.

**Data model**
- A v1 `target-facts.json` is rejected, loads to zero facts, and produces no provider-wide demotion.
- `CredentialId` grammar is enumerated **from its one definition**, including the modelless form.
- Scope precedence: an `attempt` fact beats a `credential` fact beats a `provider` fact for the same deployment.
- `clearFacts(provider, "nim#personal", …)` leaves a `credential:nim#work` fact intact.
- `clearFacts(provider, null, …)` clears deployment/provider facts and **no** credential-scoped ones.
- A persisted `{kind:"provider"}` interpretation is re-presented for acceptance, not auto-rewritten.

**Pooling** — every test uses **≥2 credentials**; with one, "selects correctly" and "cannot select at all" are the same observation.
- Key #2's 401 does not demote key #1 on the same deployment.
- Key #1's success does not clear key #2's genuine credential fault.
- Health merge: one sample under each of five credentials reports **lower** confidence than five samples under one.
- The merged ping window is timestamp-ordered before any percentile.
- Stage-1 survivor guard: both credentials carrying `subscription-required` still yields one attempt, with the reason reported.
- Lease release on every exit path — normal completion, upstream error, failover discard, stall timeout, thrown `CredentialConfigError`, client abort mid-SSE — outstanding count returns to zero in all six.
- A rejected candidate consumes no lease and no budget.
- Round expansion: a 5xx does **not** advance to a second credential on the same provider; a 401 does.
- Duplicate slot label loads with a warning and routes on the surviving slot.
- Attempt-time resolution never resurrects a load-disabled provider.

**Cost accounting**
- Usage is captured on **all three** paths: buffered, Anthropic streaming, and OpenAI-front streaming. (The third is the one that does not work today.)
- A `null` price yields `costUsd: null`, never `0`.
- `costBasis` degrades to the weakest input: `reported` tokens × `reference` price ⇒ `reference`.
- A 13-candidate failover writes 13 rows, one per credential attempted.
- A repair writes its own row with `role: "repair"` against the reshaper's credential.
- A client abort mid-stream writes a `cancelled` row retaining input tokens.
- A degrade-tail answer carries the degraded label on its row.
- The Anthropic `overflow` branch writes `tokens: unknown`, not zero.
- No `res.clone()` is introduced on any failover path.
- The usage observer never throws and never blocks a byte.
- Concurrent CLI + relay writes lose no increments (journal append).
- `pools --probe` writes no ledger rows and says so.

**Control plane**
- `TOKENLESS_CONTROL_READS` is pinned to its current five members.
- No per-credential field appears on `/telemetry`.
- No endpoint accepts or returns a secret.

---

## 8. Staged build order

Each stage is independently shippable and leaves the tree green.

### Stage 0 — Precondition refactor (behaviour-preserving)
**~1 focused session. Must land alone, before anything else.**

- Migrate the four open-coded credential sites onto `readCredential` + `buildAuthHeaders`: `src/server.ts:2610, 2638-2640`; `src/catalog.ts:373-378`; `src/reshaper.ts:180-184`.
- Fix the **live alias hole** at `src/server.ts:2609-2610`: state comes from `credentialState`, which *does* alias-fallback (`src/authEnv.ts:134`), while the value is read from `process.env[target.authEnv!]` directly — a key present only under an unfrozen alias yields `declared-present` with an `undefined` read, and **the request egresses with no credential at all**. `src/backend.ts:910` uses `readCredential` and has no such hole: two paths, one policy empty.
- Fix `src/telemetry.ts:88` — `Boolean(process.env[envVar])`, untrimmed, the last surviving `keyIsPresent` outlier.
- Fix the `authEnv: ""` + `credentialMode: "passthrough"` inconsistency (`src/config.ts:1020` vs `:1057`).
- Introduce `resolveCredential()` as the single resolver behind `credentialState` / `readCredential` / `keyIsPresent`, with only the env rungs wired.

Without this, multi-key selection has no single interception point and would silently keep using slot #1 forever, and a keystore-only provider would be dropped from routing.

### Stage 1 — Multi-key pooling on env vars
**~2–3 sessions.**

`CredentialId`, the `credentials[]` declaration, `ResolvedAttempt`, breaker re-keying to `provider#label/model` (free — in-memory), the six-scope fact model with the v2 store bump, the selection ladder, leases on `AttemptHandle`, `x-llm-relay-credential*` headers, `servedCredential` in `LOG_FIELDS`, `/candidates` credential columns.

**Immediately useful with zero crypto:** the owner has 12 keys in env vars today, and two NVIDIA keys become two quota domains the moment this ships.

**Stage 1 deliberately excludes:**
- **All encryption and the keystore.** Slots name env vars; the resolver port is there but has only env rungs. Custody is orthogonal and slots in behind an interface that already exists.
- **All currency.** No prices, no `costUsd`, no ledger. Selection uses `assessCost`'s existing free/paid/unknown class, which exists today.
- **Metering counters and the `counted` headroom rung.** Selection ships with `observed` (from `extractQuotaPercent`, already wired to both fronts) and `unknown` only. Bands with two rungs are useful; a third can be added without changing the ladder's shape.
- **Any HTTP surface for credentials.** Read-only fields on already-token-gated routes.
- **freellmapi import.** Manual export → `keys import` works today.

Excluding these keeps Stage 1's only persisted change the target-facts v2 bump, so it can be reverted by deleting one file.

### Stage 2 — Metering
**~2 sessions.**

The JSONL ledger, bucketed counters, single-writer discipline, per-credential RPM/RPD/TPM/TPD, the `counted` headroom rung, `budget-spent` as a Stage-2 demote, the shared usage tail observer on **both** fronts, usage on the completion outcome, `llm-relay usage`.

Stage 2 is where the OpenAI-front streaming gap gets closed — that is the largest single item in the whole plan and the one most likely to be underestimated.

### Stage 3 — Custody
**~2–3 sessions, of which the keyring is ~1.**

`os-keyring` (stdin-only KEK, three platforms), `keystore`, the resolver's keystore rung, `keys add/list/rotate/revoke/export/unlock`, `secret-file-acl` upgrades (SID grants, retain SYSTEM/Administrators, sync create-time hardening, `(OI)(CI)` directory).

Ships **after** pooling because pooling delivers value with no crypto risk, and because Stage 1's resolver port is exactly the seam custody plugs into — building it first means designing that seam speculatively.

### Stage 4 — Cost accounting in currency
**~1–2 sessions.**

`costUsd` and `costBasis` derived from `resolveMetadata`'s existing price rungs, attribution across failover/repair/cancellation/degrade-tail, daily rollups, `llm-relay cost`.

Smallest stage because it is nearly all *derivation* over Stage 2's ledger — the hard parts (observing tokens on both fronts, keying by credential, deciding what an attempt row means) are already paid for.

---

## 9. Findings I judged wrong, or overstated

- **Design 1: "`credentialState` must not gain a fourth value, therefore it need not change."** The first clause is right, the conclusion is wrong. Both reviews caught it. `src/config.ts:729` and `src/server.ts:2632-2637` make it the admission predicate; leaving it reading `process.env` only means custody silently does nothing. Folded in as Stage 0.
- **Design 1: "with DPAPI there is no key file at all" / "lifted out of a backup is undecryptable."** Overstated. The master key *is* a file in the same profile, and a whole-profile backup plus the account password decrypts CurrentUser blobs. Restated honestly in §2.3; the improvement over a key beside the ciphertext is real and survives precise phrasing.
- **Design 1: envelope encryption as a pure win.** Incomplete, not wrong. Its cost (KEK and decrypted secrets resident in a days-long process heap) is stated in §2.3; the conclusion — still use the envelope — survives.
- **Design 1: `fingerprint` = truncated SHA-256 of the secret, safe to log.** Wrong by its own standard: an unkeyed digest of the secret is an offline verifier derived from the secret's bytes, which is exactly its objection to freellmapi's `maskKey`. Replaced with HMAC under the KEK.
- **Design 1: plaintext `export` as a precondition of storing.** Inverts the design's own threat model. Replaced with passphrase-encrypted, on-demand export.
- **Design 1: freellmapi import Route A is "one command" behind `skipsReauth`.** Half the gate. `app.ts:226` puts `/api/keys` behind `requireAuth` (a session bearer token); `keys.ts:380-382` waives only the password re-verification. Automating it means custodying a second credential to migrate keys once. Manual import wins.
- **Design 2: existing `{kind:"provider"}` facts "migrate to `credential`".** Not constructible — a v1 fact never named a credential, and `load()` casts without validating, so the "migration" is silently a *widening*. Replaced with a v2 bump that drops `p:` facts.
- **Design 2: credential-aware clearing "falls out of the keying rather than being coded".** Wrong — `clearFacts`/`covers` are called from credential-less paths (`src/context-limits.ts:110`). Requires an explicit fail-closed parameter.
- **Design 2: per-credential `base` as the recommended alternative to per-key proxies.** Its own reasoning for declining proxies applies verbatim, and it is an egress-redirect primitive on a stored credential that the AAD does not bind. Dropped.
- **Design 2: merging ping windows "solves the confidence dilution".** It creates the opposite defect — five single observations of five accounts would report full confidence. Merge the tendency, not the confidence.
- **Design 2: three new hard config errors.** Only one has a credential consequence. The other two contradict `src/config.ts`'s established degrade posture and would take down every client session over a typo. Downgraded to slot-disabling warnings.
- **Security review, finding on `keys add` argv:** correct and I extended it — the same rule had to be applied to the KEK, which was the gap.
- **Security review, "cost accounting design absent":** correct as a process observation. §4 is written fresh here against source rather than merged from a design that was never delivered, and its two decisive facts (`completeAttemptSuccess` carries only a status; the OpenAI front streams unaccumulated) are my own verification, not either design's claim.