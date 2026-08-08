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
  performance: 'readonly',
  NodeJS: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  RequestInit: 'readonly',
  ReadableStream: 'readonly',
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
  // docs/suggestion-review-2026-08-04.md rejected against the project's own rubric. Kept as a
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
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
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
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
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
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
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
];
