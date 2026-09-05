# Implementation map — dispatch telemetry (recon 2026-09-04)

Companion to [dispatch-telemetry-design-2026-09-04.md](dispatch-telemetry-design-2026-09-04.md).
Gathered by three read-only `opencode-muse-spark` lanes (jobs 0005–0007) and spot-checked by the
orchestrating session. Line numbers are as of commit `48a5bbb`; re-grep before editing.

## A. MCP side (`src/mcp/server.ts`, `src/mcp/lane-runner.ts`, `src/cli.ts`)

- `McpServerDeps` (`src/mcp/server.ts:81-106`): `config`, `buildView: DispatchViewBuilder`,
  `spawn?`, `fetch?: AnswerFetch`, `now?`, `cwd?`, `allowedRoots?`, `maxDepth?`, `version?`,
  `reportExhaustion?: (report: DispatchedQuotaReport) => Promise<void> | void` (line 104),
  `write: (chunk: string) => void`.
- Agent-mode terminal state: `toolDispatch` settled handlers (`server.ts:622-662`) —
  `this.jobs.complete(job.id, r, semanticFailure)` (655) and `this.jobs.fail(job.id, e.message)`
  (659). The exhaustion callback is invoked at `await this.deps.reportExhaustion?.(report)`
  (638) with a `DispatchedQuotaReport` (`lane-runner.ts:143-148`) built by
  `classifyDispatchedResult` (`lane-runner.ts:155-161`).
- Answer-mode terminal state: `dispatchAnswer` settled handlers (`server.ts:700-715`) —
  `this.jobs.complete(job.id, outcome.run, semanticFailure, outcome.relay)` (707). Both paths
  respect a prior `cancelled` (626, 702, 711).
- `mode` is read once by `readMode(args)` (`server.ts:298-300`, used at 578); the answer path is
  taken only when `mode === "answer" && lane.kind === "relay"` (580). `mode` is NOT stored; the
  only after-the-fact discriminator is `job.relay` ("Set only for an answer-mode job",
  `lane-runner.ts:107`). The task text is a local in `toolDispatch` (`server.ts:550`) and is never
  stored on the job — the forwarding hook must capture `task.length` at dispatch time.
- `LaneJob` (`lane-runner.ts:90-108`): `id, status, laneId, spec, startedAt, endedAt, exitCode,
  stdout, stderr, timedOut, cwd, error, relay?`. Set in `create` (494-511: `startedAt: Date.now()`),
  `complete` (535-555: `exitCode/stdout/stderr/timedOut`, `endedAt`, status
  completed/failed/timed_out), `fail` (557-564), `cancel` (566-575). The job does not carry the
  lane KIND — read it from the `DispatchLane` the view returned (`lane.kind`) at dispatch time.
- `JobStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out"` (`lane-runner.ts:66`);
  `TERMINAL_JOB_STATUSES` (73). `LaneJobStore` methods: `create`, `registerKill`, `get`, `list`,
  `complete(id, run: LaneRunResult, semanticFailure?, relay?)`, `fail(id, error)`, `cancel(id)`,
  `cancelAll()` (490-580). `complete()` has NO hook or event; callers observe through the settled
  promise chains at `server.ts:622` and `700`.
- `LaneRunResult` (`lane-runner.ts:111-116`): `code: number | null`, `stdout`, `stderr`, `timedOut`.
  `isContentEmpty` (132-134), `EMPTY_OUTPUT_REASON` (141).
- `reportMcpExhaustion(cfg, report, request = tryServer)` (`cli.ts:1210-1225`): POSTs
  `proxyUrl(cfg, "/dispatch")` with `{ "content-type": "application/json" }`; `tryServer`
  (`cli.ts:1173-1187`) attaches the control token via
  `createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath)).attach(headers)`
  and returns `null` on `!res.ok` or throw; the caller then throws
  `no proxy running - quota report not recorded`. `proxyUrl` (`cli.ts:1229-1231`).
- `runMcp` (`cli.ts:2410-2420`) builds the deps: `config: cfg`, `buildView: (o) =>
  resolveDispatchView({ ...o, cfg })`, conditional `allowedRoots`, `version: currentVersion()`,
  `reportExhaustion: (report) => reportMcpExhaustion(cfg, report)`, `write`. `spawn/fetch/now/cwd/
  maxDepth` take constructor defaults (`server.ts:403-407`).
- `resolveDispatchView` (`cli.ts:2357-2400`) tries the LIVE daemon `GET /dispatch?…&host=bypassed`
  first and falls back to `buildDispatch` — so the daemon's config decides the lane command.

## B. Daemon side (`src/routes/admin.ts`, `src/server.ts`, accounting, dispatch state)

- Admission is `admissionFailure` in `src/server.ts:173-212`, in order: exactly one `Host` matching
  `listenerAuthority` (183-189); `Origin` only if present, `http:` + same host:port (191-196);
  mutating methods need `content-type: application/json` (198-204); control routes that are not
  tokenless GETs need `validateControlAuthorization(authorization, req.headers)` (206-211;
  `control-authorization.ts:216-219`). Failure ⇒ 403 via `failClosed` (416-422).
  `TOKENLESS_CONTROL_READ_PATHS` (`server.ts:110-117`) is frozen by
  `test/loopback-admission.test.ts:95-101` to exactly `["/v1/models","/models","/offload",
  "/dispatch","/telemetry"]`; `CONTROL_ROUTES` (`server.ts:119-127`). A new POST-only route must
  join `CONTROL_ROUTES` and NOT the tokenless list.
- Body: `readBody(req, cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)` (`server.ts:428`),
  `JSON.parse`, then `reqJson` flows into `handleAdminRoutes` (441-451). `POST /dispatch` reads
  `(reqJson ?? {})` (`admin.ts:333`); 200 via `ok(view, true)` (184-189, 397); 400 via `bad()` →
  `failClosed(res, status, message)` (158-161, 190-194) for bad `outcome` (336), bad `client`
  (349), unknown lane (358), missing `exhausted/clear` (362), `?task=` over `MAX_TASK_LEN = 4096`
  (20, 366).
- `AdminHandlers` (`admin.ts:145-156`): `catalog`, `pingLoop?`, `logger`, `breaker`,
  `accountingReader?: Pick<AccountingStore, "usedInWindow">`. No recorder is reachable today. The
  store is built in `cli.ts:962` (`createAccountingStore({ retentionDays: 30 })`) and passed as
  `accountingRecorder` + `accountingReader` (963-966); `createProxy` defaults
  `deps.accountingRecorder ?? NOOP_ACCOUNTING_RECORDER` (`server.ts:728`) into
  `Handlers.accountingRecorder: AccountingRecorder` (350) and `accountingReader` (885-888).
  ⇒ Add `accountingRecorder: AccountingRecorder` to `AdminHandlers` and pass `h.accountingRecorder`.
- Accounting low-level API (`accounting.ts`): `createAccountingRequest(options)` (1004-1006),
  `startAttempt` (769), attempt `complete` (845), request `complete` (897). Event shapes at
  163-234. `client` is `string | null` (166) — `"mcp-dispatch"` fits with NO vocabulary change;
  `ATTRIBUTIONS` already holds `unknown` (`dashboard-contract.ts:117-118`); `TOKEN_BASES`
  reported/estimated (179); estimate `method` is an open safe string (`accounting.ts:405-414`,
  `accounting-store-schema.ts:652-654`). A persisted row with client `mcp-dispatch` reloads:
  `isRequestPacket`/`isDimensionRow` accept any safe id (`accounting-store-schema.ts:1153, 882`).
  `FRONT_DOOR_CLIENTS` (`config.ts:484`) governs offload routing only, not accounting.
- Simplest write (lane 0006's reading of `accounting.ts:255-298`):
  `const req = createAccountingRequest({ recorder, client: "mcp-dispatch", attribution: "unknown" });`
  `const att = req.startAttempt({ role: "serve", attribution: "unknown", provider: null, model: <lane id>, credentialId: null });`
  `att.complete({ outcome, tokens: { estimated: { inputTokens, outputTokens, inputMethod, outputMethod } } });`
  `req.complete({});` — no price port ⇒ `spend: null` (unpriced), `tokenBasis: "estimated"`.
  ⚠ Verify the exact option shapes against `accounting.ts:255-298` before coding; the lane
  paraphrased them. `failed`/`timed_out` must complete with `outcome: "error"` and a failure kind
  from `FAILURE_KINDS` (`dashboard-contract.ts:106-114`).
- Dispatch exhaustion state: `WeakMap<Config, Map<string, number>>` (`dispatch.ts:202`),
  `cooldownsFor(cfg)` (205-212), keys `rung:<id>` / `quota:<name>` (214-216); ops
  `markExhaustedKey`, `clearExhaustedKey`, `exportExhaustedRows`, `restoreExhaustedRows`,
  `onExhaustionChanged` (247-350). Row `{ key, until }`.
- Persistence pattern (`dispatch-exhaustion-persistence.ts`): `CURRENT_…_VERSION = 1` (32),
  `getDispatchExhaustionPath()` (39, vitest redirect at 42, `join(relayStatePath("cache"),
  "dispatch-exhaustion.json")` at 45), `loadExhaustedRows(opts)` (62-72: version mismatch ⇒ `[]`,
  per-row `isExhaustedRow` 49-55), `saveExhaustedRows(rows, opts)` (74), and
  `installDispatchExhaustionPersistence(cfg, opts)` (84-95: restore, then
  `onExhaustionChanged(cfg, () => timer.touch(() => save(export(cfg))))`). `WriteBehindTimer.touch(
  flush, now)` (`write-behind.ts:24-32`). `createProxy` installs it only outside vitest
  (`server.ts:725`).

## C. Surfaces, tests, docs

- Ladder row rendering: MCP `laneSummary(lane: DispatchLane)` (`src/mcp/server.ts:383-390`, used
  by `toolLanes` 507-522); CLI `runDispatch` loop `for (const l of view.ladder)`
  (`cli.ts:2614-2662`, `note:` line at 2661); `--json` returns the raw `DispatchView`. `DispatchLane`
  (`dispatch.ts:57-129`) / `DispatchView` (131-149); `buildDispatch` (830-834).
  Least change: optional stats fields on `DispatchLane`, one `bits.push` in `laneSummary`, one or
  two stdout lines in `runDispatch`; `GET /dispatch`, `--json` and `dispatch_lanes` then carry them.
  `runLanes` (`cli.ts:2280`) renders the lane-manifest probe table, not ladder rows.
- Tests to model on: `test/mcp-server.test.ts` — `lane()` (41-51), `view()` (63),
  `fakeSpawner(result, delayMs)` (78), `class Harness` (93-108, injects `buildView`, `spawn`,
  `cwd`, `write`), `request`/`tool` helpers (110-123), job-to-terminal drive with fake timers
  (417-437), cancel (443-462). `test/dispatch.test.ts:396-500` — `describe("dispatch ladder -
  endpoint")` with the control token injected at 397-400. Admission matrices:
  `test/loopback-admission.test.ts:76-84, 95-110, 307-311` and `test/cooldown-clear.test.ts:341-377`
  (`it.each` token / content-type / Origin ⇒ 403). `test/persistent-paths-vitest.test.ts:33-49`
  `DEFAULT_PATHS` table (8 rows) — a new cache-kind artifact adds one row
  `[name, getDispatchLaneStatsPath, join(VITEST_ROOT, "dispatch-lane-stats.json")]` and its
  resolver carries the `process.env.VITEST` guard. `test/architecture-map.test.ts:20-48` — every
  `src/` file must be named as a backticked `` `path` `` (or its `` `dir/` ``) in `CLAUDE.md`'s
  table. `test/dispatch-exhaustion-persistence.test.ts:37-155` — temp-dir fixture, `freshConfig()`
  per restart, corrupt/wrong-version/malformed-row/debounce cases.
- `docs/reference.md` extension points: state-file list 143-148 and XDG table 152-158; dispatch
  ladder + exhaustion report 1312-1323; MCP tools table 1550-1558 and semantics 1560-1624; control
  endpoints table 2031 (`GET|POST /dispatch`) and token paragraph 2039-2046.

## D. Packet split (orchestrator's decision)

1. **Packet 1 — daemon record + lane stats.** New `src/dispatch-lane-stats.ts` (per-Config series
   + `dispatch-lane-stats.json` persistence, `WriteBehindTimer`, vitest guard); `AdminHandlers`
   gains `accountingRecorder`; `POST /dispatch/telemetry` in `routes/admin.ts` + `CONTROL_ROUTES`;
   validation of the report body; accounting write for `kind: "cli"` only. Tests:
   `test/admin-dispatch-telemetry.test.ts`, `test/dispatch-lane-stats.test.ts`, the
   persistent-paths row, architecture-map row in `CLAUDE.md`.
2. **Packet 2 — MCP forwarding.** `DispatchedTelemetryReport` type; `McpServerDeps.reportTelemetry`;
   capture `task.length` + `lane.kind` at dispatch; forward on agent-mode terminal states except
   cancelled; `reportMcpTelemetry` in `cli.ts` beside `reportMcpExhaustion`; wire in `runMcp`.
   Tests: `test/mcp-telemetry-forwarding.test.ts`.
3. **Packet 3 — surfaces + docs.** Stats fields on `DispatchLane`, `laneSummary`, `runDispatch`;
   `docs/reference.md`; `CLAUDE.md` rows; HANDOFF/backlog; design doc final state.
4. **Packet 4 — adversarial review** of the whole diff against the invariants, then release.
