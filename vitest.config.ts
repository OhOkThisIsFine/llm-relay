import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the repo's own suite. Without an explicit include, vitest's default
    // glob walks the whole tree — including the per-node git worktrees that the
    // remediation tooling creates under .audit-tools/worktrees/, so `npm test`
    // in this checkout ran every worktree's copy of every test file too (70
    // files / 638 tests instead of the real suite). That makes the gate
    // meaningless in both directions: another worktree's half-finished edit can
    // fail this tree's run, and a worktree's stale copy can pass one.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".audit-tools/**"],
  },
});
