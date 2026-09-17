import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import sonarjs from 'eslint-plugin-sonarjs';

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  performance: 'readonly',
  NodeJS: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  RequestInit: 'readonly',
  ReadableStream: 'readonly',
  TransformStream: 'readonly',
  WritableStream: 'readonly',
  ReadableStreamDefaultReader: 'readonly',
  TransformStreamDefaultController: 'readonly',
  structuredClone: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

// This toolchain is ADVISORY. It is deliberately not wired into `npm run check`, so CI still
// gates on the two typechecks plus the suite. A rule is kept only where it can find a real defect
// in THIS codebase; where a rule contradicts a documented invariant it is turned off with the
// invariant named, because a permanently-red check teaches everyone to ignore the output — which
// costs more than the rule was ever worth.
const sharedRules = {
  ...js.configs.recommended.rules,
  ...sonarjs.configs.recommended.rules,

  // ── Contradicts a documented invariant ────────────────────────────────────────────────────
  // This proxy is LOOPBACK-ONLY and refuses a non-loopback bind; `http://127.0.0.1` is the
  // architecture, not an oversight. See "Loopback only" in CLAUDE.md.
  'sonarjs/no-clear-text-protocols': 'off',
  // The dispatch ladder names agent CLIs (`claude`, `codex`, `agy`) for the HOST to resolve and
  // run. That is the design — the relay never spawns them — and rung commands are operator
  // config, not untrusted input. See "The dispatch ladder decides ORDER, never execution".
  'sonarjs/no-os-command-from-path': 'off',
  // Used for temp-file suffixes and probe jitter, never for anything security-bearing.
  'sonarjs/pseudo-random': 'off',

  // ── Style opinions this codebase does not share ───────────────────────────────────────────
  // Nested ternaries and template literals are used deliberately and densely here (see the
  // `reason` construction in dispatch.ts); rewriting them would be churn, not clarity.
  'sonarjs/no-nested-conditional': 'off',
  'sonarjs/no-nested-template-literals': 'off',
  'sonarjs/concise-regex': 'off',
  // Lexicographic `.sort()` on ASCII model/provider ids is exactly what is wanted.
  'sonarjs/no-alphabetical-sort': 'off',
  // `void somePromise()` is the idiomatic way to mark a deliberately un-awaited call. Removing it
  // does not make the call awaited — it just deletes the marker saying it was on purpose.
  'sonarjs/void-use': 'off',
  // `wantsStream`-style flags and the small `switch`es here read fine and match the surrounding
  // code; splitting them into method pairs would be churn on request-path code.
  'sonarjs/no-selector-parameter': 'off',
  'sonarjs/no-small-switch': 'off',
  'sonarjs/no-undefined-argument': 'off',
  // Fires on `TransitionResult` returns, whose value differs by the `ok` discriminant it carries.
  'sonarjs/no-invariant-returns': 'off',
  // Each of these tests names a distinct scenario in its title; collapsing them into a table
  // trades the failure message that says WHAT broke for one that says "case 3".
  'sonarjs/parameterized-tests': 'off',

  // Advisory: every current hit is `let x = <init>` before a try whose catch returns early — a
  // known false-positive shape for this rule, not a discarded computation. Kept as a warning
  // because a genuine one is worth seeing.
  'no-useless-assignment': 'warn',

  // ── Advisory: worth reading, never blocking ───────────────────────────────────────────────
  // Restructuring `server.ts`/`config.ts` to satisfy this is the enterprise-shaped refactor
  // docs/history/suggestion-review-2026-08-04.md rejected against the project's own rubric. Kept as a
  // warning so a NEW hotspot is still visible.
  'sonarjs/cognitive-complexity': ['warn', 15],
  // All current hits are on operator-authored config and vendor version strings, not on request
  // bodies. Kept as a warning so one on a request path gets noticed.
  'sonarjs/super-linear-regex': 'warn',
};

/**
 * TypeScript-only rules. Kept out of `sharedRules` because that object also feeds the plain
 * `.mjs` block, and eslint hard-errors when a rule names a plugin absent from the SAME config
 * object — a config that fails to load lints nothing at all.
 */
const tsRules = {
  ...tsPlugin.configs.recommended.rules,
  // `_name` is this codebase's discard convention (`_omit`, `_dropped`, `_ignored`), and
  // `const { reshaper, ...rest } = cfg` is how a test builds a config with one key removed.
  // Both are intentional; "fixing" either would change behaviour.
  'sonarjs/no-unused-vars': 'off', // duplicate of the rule below, which takes options
  'no-redeclare': 'off',
  '@typescript-eslint/no-redeclare': 'error',
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    ignoreRestSiblings: true,
  }],
};

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'analysis-reports/**'],
    languageOptions: {
      globals: NODE_GLOBALS,
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      sonarjs,
    },
    rules: {
      ...sharedRules,
      ...tsRules,
    },
  },
  {
    files: ['test/**/*.ts'],
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'analysis-reports/**'],
    languageOptions: {
      globals: NODE_GLOBALS,
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.test.json',
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      sonarjs,
    },
    rules: {
      ...sharedRules,
      ...tsRules,
      'no-undef': 'off',
      // Test-only relaxations. Each fires on something the suite does ON PURPOSE:
      // temp dirs are how these tests stay hermetic (see the probe-cache note in CLAUDE.md);
      // `any` appears where a test deliberately hands a surface the wrong shape to prove it is
      // rejected; and assertion style is not a defect class.
      'sonarjs/publicly-writable-directories': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/prefer-specific-assertions': 'off',
      // ⚠ NOT relaxed here: `@typescript-eslint/no-unused-vars`. A stale import in a test is how
      // an assertion silently stops covering what its name claims. tsconfig.test.json exists for
      // the same reason — see the "tests asserting against a shape the source no longer has" note.
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'analysis-reports/**'],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: 'module',
      ecmaVersion: 'latest',
    },
    plugins: {
      sonarjs,
    },
    rules: {
      ...sharedRules,
    },
  },
  {
    // INVARIANT: a refusal is interpreted by LOOKUP, never by inference, and these three modules
    // hold the curated pattern tables that lookup reads. Every regex is a literal transcription of
    // wording a provider was first observed emitting — `rate-limits.ts` records only an explicit
    // limit with a confidently identified axis AND period, `context-limits.ts`'s siblings here must
    // capture the MAXIMUM and never the requested count, and `quota-observation.ts` declines a
    // header it cannot attribute rather than guessing an axis. Rewriting one to satisfy a
    // complexity budget is how a pattern comes to match something nobody observed, which is the
    // one failure these stores exist to prevent. They are also bounded before they run: each
    // parser truncates its input first, so the super-linear shape the rule warns about cannot be
    // driven by a hostile body.
    files: ['src/refusal-interpretation.ts', 'src/rate-limits.ts', 'src/quota-observation.ts'],
    rules: {
      'sonarjs/regex-complexity': 'off',
    },
  },
  {
    // INVARIANT: these comparisons are runtime guards at boundaries the TYPE system believes are
    // total, and every one of those boundaries is real. `AccountingRecorder` is a published
    // interface, so `accounting-store.ts` must degrade rather than throw on a caller that hands it
    // null; `dispatch.ts` states the rule on the line above the one flagged ("never throw
    // mid-render or evict on garbage"); `circuit-breaker.ts` casts `handle as unknown` FIRST,
    // precisely to signal that the value being checked is foreign; and `keystore.ts` is narrowing
    // an overload's own arguments. A type that describes the INTENDED caller is not evidence about
    // the actual one — the same reasoning `key-checker.ts` follows when it declines to call an
    // unproven credential bad.
    files: [
      'src/accounting-store.ts',
      'src/accounting-store-schema.ts',
      'src/circuit-breaker.ts',
      'src/cli.ts',
      'src/dashboard-snapshot.ts',
      'src/dispatch.ts',
      'src/keystore.ts',
      'src/mcp/lane-runner.ts',
    ],
    rules: {
      'sonarjs/different-types-comparison': 'off',
    },
  },
  {
    // INVARIANT: `!(cell.known > 0)` is NOT `cell.known <= 0`. The two differ on NaN, and this
    // predicate decides whether a token cell counts as MEASURED at all — the comment above it
    // states the rule in as many words ("absence of evidence, not evidence of consumption"). The
    // rewrite this lint suggests would admit an unusable reading as a measurement, which is the
    // provenance invariant facing the wrong way.
    files: ['src/accounting-store.ts'],
    rules: {
      'sonarjs/no-inverted-boolean-check': 'off',
    },
  },
  {
    // INVARIANT: the control-character range IS the guard. `dashboard-static.ts` rejects a manifest
    // path containing one because that is how a traversal is smuggled through, and
    // `dashboard-routes.ts` does the same for a query value it may echo. Deleting the range to
    // satisfy the rule removes exactly the defect the rule imagines it is preventing.
    files: ['src/dashboard-static.ts', 'src/dashboard-routes.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // INVARIANT: an alias here names a DOMAIN concept that happens to share another's underlying
    // type today. `HardCapSource` is `ConfiguredLimitSource` because a hard cap resolves through
    // the same per-axis ladder, not because the two are the same idea. Collapsing them couples two
    // vocabularies this repository documents as separate and leaves free to diverge.
    files: ['src/accounting-store-schema.ts', 'src/accounting.ts', 'src/configured-limits.ts'],
    rules: {
      'sonarjs/redundant-type-aliases': 'off',
    },
  },
  {
    // INVARIANT: a result-or-error union return is this repository's established shape for a parser
    // that must not throw. `parsePairs` returns rows or a `QueryParseError`; `credentialAttemptLabel`
    // returns a closed label union. Narrowing either to a single type would force a throw or a
    // sentinel, and the surrounding code exists to avoid both.
    files: ['src/candidate-runner.ts', 'src/dashboard-routes.ts'],
    rules: {
      'sonarjs/function-return-type': 'off',
    },
  },
  {
    // INVARIANT: the Windows `.cmd` fallback is a callback inside a callback because
    // `child_process.exec` is callback-shaped and the retry can only be issued from the first
    // call's error path. Flattening it would lose the `killed` and `child` state the retry reads.
    files: ['src/mcp/lane-runner.ts'],
    rules: {
      'sonarjs/no-nested-functions': 'off',
    },
  },
  {
    // INVARIANT: each of these fires on something the SUITE does on purpose, which is the same
    // reasoning the test block above already records — fixture and assertion style is not a defect
    // class. `no-hardcoded-passwords` fires on fixture secrets that exist so custody tests never
    // touch a real keystore; `no-nested-functions` on test scaffolding; `no-empty` on a stub's
    // deliberate `catch {}`; `no-all-duplicated-branches` and `no-identical-functions` on table
    // rows that are MEANT to read identically; and `no-floating-point-equality`,
    // `prefer-regexp-exec` and `no-non-null-asserted-optional-chain` on assertion spellings.
    //
    // ⚠ Still NOT relaxed, for the reason the block above gives: `@typescript-eslint/no-unused-vars`
    // and `sonarjs/unused-import`. A stale import in a test is how an assertion silently stops
    // covering what its name claims, and this lap deleted eight such imports rather than hide them.
    files: ['test/**/*.ts'],
    rules: {
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/no-nested-functions': 'off',
      'no-empty': 'off',
      'sonarjs/no-all-duplicated-branches': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-floating-point-equality': 'off',
      'sonarjs/prefer-regexp-exec': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },
];
