import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function toPortablePath(path: string): string {
  return path.replace(/\\/gu, "/");
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
          packagePath: toPortablePath(relative(projectRoot, directory)),
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
  plugins: [react(), dashboardBundleGraph()],
  css: {
    postcss: {
      plugins: [tailwindcss({ config: "dashboard/tailwind.config.cjs" }), autoprefixer()],
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
  },
});
