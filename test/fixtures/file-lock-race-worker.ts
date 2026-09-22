import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { withFileLockSync } from "../../src/storage/file-lock.js";

const [mode, dir, pauseAt = "owner-read"] = process.argv.slice(2);
if (dir === undefined || !["holder", "late", "replacement"].includes(mode ?? "")) {
  throw new Error("Expected holder|late|replacement and a private test directory");
}
const target = join(dir, "rows.json");
const lockPath = `${target}.lock`;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const mark = (name: string): void => fs.writeFileSync(join(dir, name), "ready");
function wait(name: string): void {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(join(dir!, name))) {
    if (Date.now() >= deadline) throw new Error(`Barrier not released: ${name}`);
    Atomics.wait(sleeper, 0, 0, 5);
  }
}

let resumed = false;
if (mode === "late") {
  const originalRead = fs.readFileSync;
  let ownerReads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const value = Reflect.apply(originalRead, fs, args);
    // Pause after the final owner bytes have been read, before reclamation. The actual
    // implementation runs unchanged; the barrier works with old and new marker names.
    if (pauseAt === "owner-read" && dirname(String(args[0])) === lockPath && ++ownerReads === 2) {
      mark("late-validated");
      wait("resume-late");
      resumed = true;
    }
    return value;
  }) as typeof fs.readFileSync;
  const originalRmdir = fs.rmdirSync;
  fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
    if (pauseAt === "retired-marker" && String(args[0]) === lockPath && !resumed) {
      mark("late-validated");
      wait("resume-late");
      resumed = true;
    }
    return Reflect.apply(originalRmdir, fs, args);
  }) as typeof fs.rmdirSync;
  syncBuiltinESMExports();
}

withFileLockSync(target, () => {
  if (mode === "holder") {
    mark("holder-entered");
    wait("release-holder");
    return;
  }
  const rows = JSON.parse(fs.readFileSync(target, "utf8")) as string[];
  mark(`${mode}-entered`);
  if (mode === "replacement") wait("release-replacement");
  fs.writeFileSync(target, JSON.stringify([...rows, mode]));
}, {
  retryMs: 5,
  timeoutMs: 15_000,
  onContention: () => {
    if (resumed) mark("late-blocked");
  },
});
