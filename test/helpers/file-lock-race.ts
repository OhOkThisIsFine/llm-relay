import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Worker {
  child: ChildProcess;
  closed: Promise<Exit>;
  stderr: () => string;
  error: () => Error | undefined;
  exit: () => Exit | undefined;
}

/** Real-process, barrier-controlled RMW race; usable against the pre-fix implementation. */
export async function exerciseReclamationRace(options: {
  workerPath?: string;
  execArgv?: string[];
  pauseAt?: "owner-read" | "retired-marker";
} = {}): Promise<{
  enteredWhileReplacementHeld: boolean;
  rows: string[];
  exits: Exit[];
  stderr: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "relay-lock-race-"));
  const workerPath = options.workerPath ?? fileURLToPath(new URL("../fixtures/file-lock-race-worker.ts", import.meta.url));
  const execArgv = options.execArgv ?? ["--import", "tsx"];
  const workers: Worker[] = [];
  function start(mode: string): Worker {
    const child = spawn(process.execPath, [...execArgv, workerPath, mode, dir, options.pauseAt ?? "owner-read"], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let error: Error | undefined;
    let exit: Exit | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
    child.on("error", (err) => { error = err; });
    const closed = new Promise<Exit>((resolve) => {
      child.once("close", (code, signal) => {
        exit = { code, signal };
        resolve(exit);
      });
    });
    const worker = { child, closed, stderr: () => stderr, error: () => error, exit: () => exit };
    workers.push(worker);
    return worker;
  }
  async function until(predicate: () => boolean, active: typeof workers): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      const failed = active.find((worker) => worker.error() !== undefined || worker.exit() !== undefined);
      if (failed !== undefined) throw new Error(`Worker stopped before barrier: ${failed.error() ?? failed.stderr()}`);
      if (Date.now() >= deadline) throw new Error("Timed out waiting for reclamation barrier");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const marker = (name: string): string => join(dir, name);
  try {
    writeFileSync(join(dir, "rows.json"), "[]");
    const holder = start("holder");
    await until(() => existsSync(marker("holder-entered")), [holder]);
    holder.child.kill();
    await holder.closed;

    const late = start("late");
    await until(() => existsSync(marker("late-validated")), [late]);
    const replacement = start("replacement");
    await until(() => existsSync(marker("replacement-entered")), [late, replacement]);
    writeFileSync(marker("resume-late"), "go");
    await until(() => existsSync(marker("late-entered")) || existsSync(marker("late-blocked")), [late, replacement]);
    const enteredWhileReplacementHeld = existsSync(marker("late-entered"));
    writeFileSync(marker("release-replacement"), "go");
    const exits = await Promise.all([late.closed, replacement.closed]);
    return {
      enteredWhileReplacementHeld,
      rows: JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")) as string[],
      exits,
      stderr: [late.stderr(), replacement.stderr()],
    };
  } finally {
    for (const worker of workers) {
      if (worker.exit() === undefined) worker.child.kill();
    }
    // Wait for handles to close before removing fixtures, especially on Windows.
    await Promise.all(workers.map((worker) => worker.closed));
    rmSync(dir, { recursive: true, force: true });
  }
}
