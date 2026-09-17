# HOTSPOT-02 — CLI Sub-Command Runner Extraction (`src/cli.ts`)

Scope: extract the sub-command runners out of monolithic `src/cli.ts`
(hotspot score 10,355; churn 109; max cognitive 95 in `runDispatch`, 87 in
`runPools`, 80 in `runOffload`, 71 in `runEligibility`; 244 functions, highest
aggregate cognitive in the repo) into `src/cli/commands/`, leaving `src/cli.ts`
as the top-level argument parser and command router.
Adversarial verdict: ACCEPT per `docs/history/reviews/adversarial-verification-2026-09-05.md`
(move per-command modules, do not rewrite).

Target modules:

- `src/cli/commands/dispatch.ts` — `runDispatch`, `recordSpentDispatchLane`,
  `renderNextCommandOrExit`
- `src/cli/commands/dispatch-view.ts` — `resolveDispatchView` with its
  daemon-preferring / local-fallback ladder logic (shared by `runDispatch` and
  `runMcp`)
- `src/cli/commands/pools.ts` — `runPools` with its table rendering
- `src/cli/commands/cost.ts` — `runCostCommand`, `CostCommandDependencies`,
  `CostWindow`, and the cost report render helpers
- `src/cli/commands/keys.ts` — `runKeysSubcommand`, `runKeysPromise`,
  `reportKeysCommandError` (thin router over the `runKeys*` verbs that already
  live in `src/keys-cli.ts`)
- `src/cli/commands/shared.ts` — generic output and config-loading helpers
  shared by the command modules (`fitCell`, `formatTextTable`, `outputJson`,
  `proxyUrl`, `loadConfigSafely`, `loadOrExit`)
- `src/cli.ts` — keeps `main`, `run`, `classifyCommand`,
  `rawCliCommand`/`getPositionalArgs` parsing, the arity/option validators
  (`commandArityError`, `commandOptionError`, `validateKeysCommandArgs`,
  `parseCooldownClearArgs`), and the dispatch switch; delegates to the modules

## Architectural rationale and layering

Every runner is already top-level and takes either primitives or small option
bags — the file is large because runners accumulated, not because they are
entangled. The extraction therefore moves code without redesigning it, exactly
as the adversarial verdict requires.

Layering, stated as import rules:

- `src/cli/commands/*.ts` may import from `src/cli/commands/shared.ts`,
  from domain modules (`config.js`, `dispatch.js`, `catalog.js`,
  `keys-cli.js`, `lane-manifest.js`), and from `node:*`. They never import
  from the parent `src/cli.ts` — that edge would cycle, because `cli.ts`
  imports every command module for its dispatch switch.
- `shared.ts` owns only process-generic helpers with no command knowledge:
  cell/table formatting, JSON output, proxy-URL building, and the
  load-or-exit config loaders. Command-specific helpers
  (`normalizeDispatchCommands`, `substituteTaskInView`, cost row/cell
  builders, `syncAgentHook`) travel with their command module, not into
  shared — otherwise shared becomes a second monolith.
- `src/cli.ts` keeps all fail-closed entrypoint policy: the keys/cooldowns
  strict parsers that must run before help/version short-circuits, the
  first-side-effect arity gate documented at the `commandArityError` call site
  in `main`, and the `dispatchDashboardOrProxy` / `runMcp` / dashboard branches
  until a later plan moves them. Command modules never call `process.exit`
  except through the existing `runKeysPromise` / `cooldownCommandFailure` /
  `configCommandError` paths they already own — exit policy does not change.

Alternatives rejected: one module per verb (`runKeysAdd`, `runCostCommand`,
…) would create a dozen files with single re-exported functions and scatter
each command's private helpers away from their only caller. Grouping by
user-visible command keeps each module reviewable as one feature.

Compatibility: several helpers are imported by tests from the `cli.js` module
path. Every moved export keeps working by re-export from `src/cli.ts`
(the full list is in the blast radius below), so no test or external importer
changes its specifier.

## Complete blast radius

Seed symbols (verified by direct source inspection):

- Function `runDispatch` in `src/cli.ts` — the dispatch lane runner with the
  task-in-query ban comment, the staleness discriminator on the daemon view's
  `host` field, and the local-fallback build via `buildDispatch`.
- Function `resolveDispatchView` in `src/cli.ts` — shared ladder-view builder
  (daemon `tryServer` read with `?host=bypassed`, `restoreExhaustedRows`, cold
  local fallback through `loadConfigSafely` plus `loadLaneManifest`); consumed
  by `runDispatch` and by `runMcp`'s `buildView` closure.
- Function `runPools` in `src/cli.ts` — pool table runner with its probe and
  render path.
- Function `runCostCommand` in `src/cli.ts` with `CostCommandDependencies`,
  `CostWindow`, and render helpers `costCell`, `costCellBasis`, `costRowCells`,
  `costTableRows`, `writeRepairShare`, `writeAbandonedShare`,
  `writeCoveredPeriod`, `renderCostReport`.
- Function `runKeysSubcommand` in `src/cli.ts` with `runKeysPromise` and
  `reportKeysCommandError`, delegating to the `runKeysAdd` / `runKeysList` /
  `runKeysRotate` / `runKeysRevoke` / `runKeysRemove` / `runKeysDisable` /
  `runKeysEnable` / `runKeysExport` / `runKeysImport` / `runKeysUnlock` verbs in
  `src/keys-cli.ts` plus `runCheckKeys`.
- Function `main` in `src/cli.ts` — the entrypoint router: `rawCliCommand` /
  `getPositionalArgs` preamble, keys/cooldowns strict parsers, help/version
  short-circuits, option and arity gates, then the command dispatch switch
  (including `runConfigCommand`, `runRoutingCommand`, `runOnboardSubcommand`,
  `runSetupSubcommand`, `dispatchDashboardOrProxy`, `runMcp`).
- Generic helpers moving to `shared.ts`: `fitCell`, `formatTextTable`,
  `outputJson`, `proxyUrl`, `loadConfigSafely`, `loadOrExit`, with types
  `TableRow`, `RenderShell` and shell quoting (`shellFor`,
  `parseRenderShell`, `quoteArg`, `renderCommand`) only if their other
  consumers move with them — otherwise they stay in `cli.ts` and command
  modules import them through `shared.ts` re-exports. (Verify each helper's
  importer list before moving; the default is to move the six names above and
  leave shell quoting until its consumers are extracted.)

Callers and importers (behavior must be identical after the move):

- `main`'s dispatch switch — the only production caller of the moved runners;
  its branch bodies become one-line delegations.
- `runMcp`'s `buildView` closure — keeps consuming `resolveDispatchView`
  through the `cli.ts` re-export with identical signature.
- `dispatchDashboardOrProxy` — consumes dispatch-view helpers; unchanged.
- Test importers from the `cli.js` specifier (notably `test/cli.test.ts`,
  `test/cost-cli.test.ts`, `test/keys-cli.test.ts`, `test/dashboard-cli.test.ts`):
  every name they import stays exported from `src/cli.ts` via re-export.

Affected test suites: `test/cli.test.ts`, `test/cost-cli.test.ts`,
`test/keys-cli.test.ts`, `test/dashboard-cli.test.ts`,
`test/cli-update-gate.test.ts`, `test/dispatch.test.ts`,
`test/host-adaptive-dispatch.test.ts`, `test/dispatch-lane-stats-view.test.ts`,
`test/first-run.test.ts`, `test/first-run-environment.test.ts`.

Imports and exports: each new command module exports exactly its runner plus
any types the dispatch switch or tests need (`CostCommandDependencies`,
`CostWindow`, `KeysCliDependencies`-adjacent shapes stay where defined).
`src/cli.ts` re-exports every moved public name so the module path is stable.

## Specific code modifications with contracts

No contract changes: every moved function keeps its exact signature. The new
modules' contracts are therefore the existing ones, restated as the invariant
this plan guarantees. Example — the dispatch-view contract in
`src/cli/commands/dispatch-view.ts`:

```typescript
import type { Config } from "../../config.js";

export interface DispatchViewOptions {
  task?: string | undefined;
  tier?: string | undefined;
  lane?: string | undefined;
  client?: string | undefined;
  cfg?: Config;
}

export async function resolveDispatchView(opts: DispatchViewOptions): Promise<DispatchView>;
```

Contract (today's behavior, preserved verbatim):

- Never places the task in the GET query string (the task-in-query ban at the
  `URLSearchParams` construction site stays with the function).
- Prefers the running daemon via `tryServer` and applies the staleness
  discriminator (a daemon view whose `host` is not `"bypassed"` is discarded
  exactly as today); falls back to a cold local `buildDispatch` with a
  cache-only context-window resolver and `loadLaneManifest`.
- Marks the result `source: "daemon"` versus `source: "local-fallback"`.

Before (representative — inside function `main` in `src/cli.ts`, at the keys
dispatch branch following the arity gate):

```typescript
if (arg2 === "keys") {
  // …validateKeysCommandArgs fail-closed branch, unchanged…
  runKeysSubcommand(arg3, arg4);
  return;
}
```

After (same anchor — the validation preamble stays in `main`; only the runner
resolves to the new module):

```typescript
import { runKeysSubcommand } from "./cli/commands/keys.js";

// …at the same branch anchor:
if (arg2 === "keys") {
  // …validateKeysCommandArgs fail-closed branch, unchanged…
  runKeysSubcommand(arg3, arg4);
  return;
}
```

And in `src/cli.ts`, the compatibility re-exports (kept indefinitely):

```typescript
export { runDispatch } from "./cli/commands/dispatch.js";
export { resolveDispatchView } from "./cli/commands/dispatch-view.js";
export { runPools } from "./cli/commands/pools.js";
export { runCostCommand } from "./cli/commands/cost.js";
export type { CostCommandDependencies, CostWindow } from "./cli/commands/cost.js";
```

The dispatch branch in `main` changes from calling a local `runDispatch` to
calling the imported one; the `?task=` ban, host discriminator, and
`renderNextCommandOrExit` flow inside `runDispatch` move untouched.

## Step-by-step implementation sequence

1. Create `src/cli/commands/shared.ts` by moving the six generic helpers
   (`fitCell`, `formatTextTable`, `outputJson`, `proxyUrl`,
   `loadConfigSafely`, `loadOrExit`); add `cli.ts` re-exports; run the CLI
   suites to pin the seam before any runner moves.
2. Create `src/cli/commands/dispatch-view.ts` by moving `resolveDispatchView`
   verbatim (with its `URLSearchParams`, `ModelCatalog`,
   `materializeDynamicPools`, `tryServer`, `restoreExhaustedRows`,
   `buildDispatch` fallback body); rewire `runDispatch` and `runMcp` to import
   it; keep the `cli.ts` re-export.
3. Create `src/cli/commands/dispatch.ts` (`runDispatch`,
   `recordSpentDispatchLane`, `renderNextCommandOrExit`); rewire the dispatch
   branch in `main`.
4. Create `src/cli/commands/pools.ts` (`runPools` plus its probe/render
   helpers); rewire the pools branch in `main`.
5. Create `src/cli/commands/cost.ts` (`runCostCommand` plus the cost render
   helpers and their types); rewire the cost branch in `main`.
6. Create `src/cli/commands/keys.ts` (`runKeysSubcommand`,
   `runKeysPromise`, `reportKeysCommandError`); rewire the keys branch in
   `main`. The `runKeys*` verbs stay in `src/keys-cli.ts` — this module is a
   router, not a second implementation.
7. Run the verification plan below; delete no old code until all CLI suites
   pass. Explicitly out of scope: `runOffload`, `runEligibility`,
   `runCandidates`, `runConfigCommand`, `runRoutingCommand`, dashboard/MCP
   branches — each is a named follow-up, not part of this move.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/cli.test.ts
npm test -- test/cost-cli.test.ts
npm test -- test/keys-cli.test.ts
npm test -- test/dashboard-cli.test.ts
npm test -- test/cli-update-gate.test.ts
npm test -- test/dispatch.test.ts
npm test -- test/host-adaptive-dispatch.test.ts
npx tsc --noEmit
```

Automated checks and invariant assertions:

- All listed suites pass with zero help-text, table-render, or exit-code
  changes (the move is behavior-preserving by construction).
- A targeted invariant test asserts every name the test suites import from
  the `cli.js` specifier still resolves there (re-export completeness), and
  that no module under `src/cli/commands/` imports from the parent
  `src/cli.ts` (acyclicity — enforce by text search on the import specifier).
- Confirm by text search that the moved runners have exactly one definition
  each and that `src/cli.ts` contains only the parser/router plus shims.
- Confirm zero line-number references were introduced by this change (symbol
  anchors only, per this plan's mandatory constraint).
