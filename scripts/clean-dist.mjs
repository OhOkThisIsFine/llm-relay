import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");

// This script performs the build's only recursive removal. Refuse any target
// broader than this checkout's exact generated-output directory.
if (relative(root, dist) !== "dist" || dirname(dist) !== root) {
  throw new Error(`clean-dist refused unexpected target: ${dist}`);
}
if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) {
  throw new Error(`clean-dist refused symbolic-link target: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
