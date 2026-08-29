import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDiffText, repoFileReader } from "./gate.js";
import { autoRepairDiff } from "./fix.js";
import type { Verdict } from "./types.js";

export interface DelegateGateCliOptions {
  readonly diffPath: string | undefined;
  readonly repoRoot: string | undefined;
  readonly fix: boolean;
}

export interface DelegateGateCliResult {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `llm-relay delegate-gate <diff-file> --repo <root> [--fix]`
 *
 * Pure over injected IO so the contract tests can drive it without touching the real filesystem.
 * `readFile`/`writeFile` default to Node's `fs`; a caller only overrides them in tests.
 */
export function runDelegateGateCli(
  options: DelegateGateCliOptions,
  io: {
    readonly readFile?: (path: string) => string;
    readonly writeFile?: (path: string, content: string) => void;
  } = {},
): DelegateGateCliResult {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = io.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, "utf8"));

  if (options.diffPath === undefined) {
    return { exitCode: 1, stdout: "", stderr: "delegate-gate: missing required <diff-file> argument\n" };
  }
  if (options.repoRoot === undefined) {
    return { exitCode: 1, stdout: "", stderr: "delegate-gate: --repo <root> is required\n" };
  }

  let diffText: string;
  try {
    diffText = readFile(options.diffPath);
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: `delegate-gate: could not read "${options.diffPath}": ${(e as Error).message}\n` };
  }

  const repoRoot = resolve(options.repoRoot);
  const readOriginal = repoFileReader(repoRoot);

  let verdict: Verdict;
  try {
    verdict = evaluateDiffText(diffText, readOriginal);
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: `delegate-gate: could not analyze the diff: ${(e as Error).message}\n` };
  }

  let stderr = "";
  if (options.fix) {
    const repaired = autoRepairDiff(diffText, readOriginal);
    if (repaired.fixedCount > 0) {
      const fixedPath = `${options.diffPath}.fixed.patch`;
      writeFile(fixedPath, repaired.fixedText);
      stderr += `delegate-gate: wrote ${repaired.fixedCount} mechanical fix(es) to ${fixedPath}\n`;
    } else {
      stderr += "delegate-gate: no mechanically fixable findings; no .fixed.patch written\n";
    }
  }

  const stdout = `${JSON.stringify(verdict, null, 2)}\n`;
  return { exitCode: verdict.pass ? 0 : 1, stdout, stderr };
}
