import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One exported name, one declaration — across the whole of `src/`.
 *
 * The audit of 2026-09-03 (DR-001, DR-004, contract DR-008) found the closed-vocabulary defect
 * class `CLAUDE.md` already tracks operating at MODULE scope: the same exported name declared in
 * two files, each consumer bound to whichever copy it happened to import, and nothing to notice
 * when one copy moved. Measured on 2026-09-04: `config-types.ts` duplicated 31 names from
 * `config.ts` (and had already drifted), `openai-request.ts` carried a third copy of two of them,
 * `quota-observation.ts` restated `QuotaAxis`/`QuotaPeriod` from `dashboard-contract.ts`, and
 * `accounting-store-schema.ts` restated `AccountingSpendCoverage` from `accounting.ts`. The
 * per-vocabulary guard suites could not see any of it, because each pins one union it already
 * knows about; this is the general guard the audit asked for.
 *
 * A name that two files export because they are two DIFFERENT concepts sharing a word is a naming
 * smell, not a second declaration of one vocabulary. Those are allow-listed below, by file pair,
 * so a third file adopting the same word still fails here.
 */
const SRC = join(__dirname, "..", "src");
const EXPORT_DECLARATION = /^export (?:const|type|interface|function|class|enum) ([A-Za-z0-9_]+)/gm;

/** Same word, different concepts — each entry names the exact files allowed to share it. */
const DIFFERENT_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  // The delegate-gate's verdict over a diff, and the ping loop's verdict over a deployment.
  Verdict: ["delegate-gate/types.ts", "ping/metrics.ts"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

function declaringFiles(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(EXPORT_DECLARATION)) {
      const name = match[1]!;
      // Overloads declare one name several times in ONE file; that is one declaration.
      const files = byName.get(name) ?? new Set<string>();
      files.add(rel);
      byName.set(name, files);
    }
  }
  return byName;
}

describe("one exported name has one declaration across src/", () => {
  const byName = declaringFiles();

  it("scans a tree large enough to mean something", () => {
    expect(byName.size).toBeGreaterThan(500);
  });

  it("no exported name is declared in two modules, beyond the allow-listed different-concept pairs", () => {
    const offenders: string[] = [];
    for (const [name, files] of byName) {
      if (files.size < 2) continue;
      const allowed = DIFFERENT_CONCEPTS[name];
      const sorted = [...files].sort();
      if (allowed && sorted.length === allowed.length && sorted.every((f, i) => f === [...allowed].sort()[i])) continue;
      offenders.push(`${name}: ${sorted.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-listed pair still exists exactly as listed, so a stale exception cannot linger", () => {
    for (const [name, files] of Object.entries(DIFFERENT_CONCEPTS)) {
      expect([...(byName.get(name) ?? [])].sort()).toEqual([...files].sort());
    }
  });
});
