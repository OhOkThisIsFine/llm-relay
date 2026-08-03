import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelDir = fileURLToPath(new URL("../src/kernel/", import.meta.url));
const sourceFiles = readdirSync(kernelDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(kernelDir, name));

function imports(source: string): string[] {
  const staticImports = source.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g,
  );
  const dynamicImports = source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g);
  return [...staticImports, ...dynamicImports].map((match) => match[1]!);
}

describe("kernel architecture boundary", () => {
  it("imports only sibling kernel modules", () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      for (const specifier of imports(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith("./")) {
          violations.push(`${relative(kernelDir, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not expose Node, fetch, or feature implementation types", () => {
    const violations: string[] = [];
    const forbidden = /\bBuffer\b|\bNodeJS\.|\bprocess\.|\bfetch\s*\(|\bAbortSignal\b/g;
    for (const file of sourceFiles) {
      const matches = readFileSync(file, "utf8").match(forbidden) ?? [];
      if (matches.length > 0) {
        violations.push(`${relative(kernelDir, file)}: ${[...new Set(matches)].join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("has an acyclic sibling import graph", () => {
    const graph = new Map<string, string[]>();
    for (const file of sourceFiles) {
      const name = relative(kernelDir, file).replace(/\\/g, "/");
      graph.set(
        name,
        imports(readFileSync(file, "utf8"))
          .filter((specifier) => specifier.startsWith("./"))
          .map((specifier) => specifier.slice(2).replace(/\.js$/, ".ts")),
      );
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    const visit = (node: string, path: readonly string[]): void => {
      if (visiting.has(node)) {
        cycles.push([...path, node].join(" -> "));
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const dependency of graph.get(node) ?? []) visit(dependency, [...path, node]);
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });
});
