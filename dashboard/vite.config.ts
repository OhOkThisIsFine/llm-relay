import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nodeModulesRoot = join(projectRoot, "node_modules");
/**
 * Where `node_modules` PHYSICALLY lives. In a lap worktree it is a junction to the main
 * checkout's directory (`lap-worktree.mjs open` wires it that way), and Vite hands this plugin the
 * RESOLVED module id — so `relative(projectRoot, directory)` walked up and out
 * (`../../../Code/llm-relay/node_modules/react`), and `scripts/dashboard-package-check.mjs`
 * rightly refused it as non-portable (2026-09-08). The junction IS this checkout's
 * `node_modules`, so a package under its real target is reported as `node_modules/<name>`.
 */
const realNodeModulesRoot = ((): string => {
  try {
    return realpathSync(nodeModulesRoot);
  } catch {
    return nodeModulesRoot;
  }
})();

function toPortablePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

/**
 * A package directory relative to this checkout, expressed as `node_modules/...` whether the
 * directory sits under the checkout's own `node_modules` or under the junction target it resolves
 * to. A directory under neither is returned as the plain relative path, so the package check still
 * refuses a genuinely escaping resolution (an EMPTY `node_modules` that resolved upward).
 */
function packageRelativePath(directory: string): string {
  const direct = relative(projectRoot, directory);
  if (!direct.startsWith("..")) return toPortablePath(direct);
  const viaRealRoot = relative(realNodeModulesRoot, directory);
  if (!viaRealRoot.startsWith("..")) return toPortablePath(join("node_modules", viaRealRoot));
  return toPortablePath(direct);
}

function packageForModule(moduleId: string): { packagePath: string; name: string; version: string; license: string } | null {
  const sourcePath = moduleId.replace(/^\0/u, "").replace(/[?#].*$/u, "");
  if (!toPortablePath(sourcePath).includes("/node_modules/")) return null;

  for (let directory = dirname(sourcePath); ; directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest === "object" && manifest !== null && typeof (manifest as { name?: unknown }).name === "string") {
        if (
          typeof (manifest as { version?: unknown }).version !== "string" ||
          typeof (manifest as { license?: unknown }).license !== "string"
        ) {
          throw new Error(`Bundled module has incomplete package metadata: ${toPortablePath(relative(projectRoot, manifestPath))}`);
        }
        return {
          packagePath: packageRelativePath(directory),
          name: (manifest as { name: string }).name,
          version: (manifest as { version: string }).version,
          license: (manifest as { license: string }).license,
        };
      }
    }

    const parent = dirname(directory);
    if (parent === directory || !toPortablePath(parent).includes("/node_modules/")) {
      throw new Error(`Could not resolve bundled package metadata for ${toPortablePath(relative(projectRoot, sourcePath))}`);
    }
  }
}

function dashboardBundleGraph(): Plugin {
  return {
    name: "dashboard-bundle-graph",
    generateBundle(_, bundle) {
      const packages = new Map<string, { packagePath: string; name: string; version: string; license: string }>();
      const virtualModules = new Set<string>();

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const moduleId of Object.keys(output.modules ?? {})) {
          const packageInfo = packageForModule(moduleId);
          if (packageInfo) {
            packages.set(packageInfo.packagePath, packageInfo);
          } else if (moduleId.startsWith("\0")) {
            virtualModules.add(moduleId.slice(1));
          }
        }
      }

      this.emitFile({
        type: "asset",
        fileName: ".vite/dashboard-bundle-graph.json",
        source: `${JSON.stringify({
          schemaVersion: 1,
          packages: [...packages.values()].sort((left, right) => left.packagePath.localeCompare(right.packagePath)),
          virtualModules: [...virtualModules].sort(),
        }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: "dashboard",
  base: "/dashboard/",
  plugins: [react(), tailwindcss(), dashboardBundleGraph()],
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
  },
});
