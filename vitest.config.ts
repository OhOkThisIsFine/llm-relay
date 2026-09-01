import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the repo's OWN suite — this include is load-bearing, not tidiness.
    // Without it, vitest's default glob walks the whole tree, so any nested
    // checkout (a git worktree under the repo root, a vendored copy) contributes
    // its own copy of every test file. Tooling that fans work out across per-task
    // worktrees inside the repo once turned `npm test` into 70 files / 638 tests
    // instead of the real suite, which breaks the gate in both directions:
    // another worktree's half-finished edit fails this tree's run, and a stale
    // copy passes one. Don't widen it.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Process isolation, not thread isolation. The suite passes either way — measured
    // 2026-09-01, 148 files and 2,865 tests green with `forks` and with the default, at the
    // same duration — so this buys no correctness today. It is kept for Windows flake
    // resistance: this repo's standing test-failure protocol treats EBUSY/EPERM as a flake
    // first, and several stores here guard themselves into per-worker temp namespaces, which
    // a forked worker separates more strongly than a thread sharing one process.
    pool: "forks",
  },
});
