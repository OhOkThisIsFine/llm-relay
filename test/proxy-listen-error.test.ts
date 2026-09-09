/**
 * A second `llm-relay` start against a bound port exits with a clear message and touches no
 * file under `usage/` (backlog item, audit DR-009).
 *
 * Until this landed `runProxy` registered no listener `error` handler, so the second process
 * constructed its accounting store and then died on `EADDRINUSE` with an uncaught exception.
 * The policy is `onListenError` in `src/cli.ts`, pinned pure here; the third test binds a REAL
 * held port through `createProxy` with a store rooted in a temp directory and asserts the
 * directory stays empty — the store's constructor only reads, and the exit skips every flush.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onListenError } from "../src/cli.js";
import { createProxy } from "../src/server.js";
import { createAccountingStore } from "../src/accounting-store.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config } from "../src/config.js";

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function io() {
  const lines: string[] = [];
  const exits: number[] = [];
  return {
    lines,
    exits,
    handlers: {
      stderr: (line: string) => {
        lines.push(line);
      },
      exit: (code: number): never => {
        exits.push(code);
        throw new ExitSentinel(code);
      },
    },
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("onListenError — the listener's one error policy", () => {
  it("EADDRINUSE: one stderr line naming the address, then exit 1", () => {
    const t = io();
    expect(() => onListenError(errno("EADDRINUSE"), { host: "127.0.0.1", port: 8791 }, t.handlers)).toThrow(
      ExitSentinel,
    );
    expect(t.exits).toEqual([1]);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain("already listening on http://127.0.0.1:8791");
    expect(t.lines[0]).toContain("nothing under usage/ was written");
  });

  it("any other listener error is rethrown, with no exit and no output", () => {
    const t = io();
    const err = errno("EACCES");
    expect(() => onListenError(err, { host: "127.0.0.1", port: 80 }, t.handlers)).toThrow(err);
    expect(t.exits).toEqual([]);
    expect(t.lines).toEqual([]);
  });
});

describe("a second relay against a bound port", () => {
  let holder: Server | undefined;
  let proxy: Server | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    for (const s of [proxy, holder]) {
      if (s?.listening) await new Promise<void>((r) => s.close(() => r()));
    }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    proxy = holder = dir = undefined;
  });

  it("exits 1 with the message and leaves the accounting directory empty", async () => {
    holder = createServer((_req, res) => res.end());
    await new Promise<void>((r) => holder!.listen(0, "127.0.0.1", r));
    const port = (holder.address() as AddressInfo).port;

    dir = mkdtempSync(join(tmpdir(), "llm-relay-listen-error-"));
    const usage = join(dir, "usage");
    const store = createAccountingStore({ rootDir: usage, retentionDays: 30 });

    const cfg = {
      host: "127.0.0.1",
      port,
      providers: { up: { base: "http://127.0.0.1:1", kind: "anthropic", timeoutMs: 1000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as unknown as Config;
    proxy = createProxy(cfg, {
      catalog: new ModelCatalog({ cachePath: null }),
      accountingRecorder: store,
      accountingReader: store,
    });

    const t = io();
    const outcome = new Promise<ExitSentinel | Error>((resolve) => {
      proxy!.once("error", (err: NodeJS.ErrnoException) => {
        try {
          onListenError(err, cfg, t.handlers);
        } catch (e) {
          resolve(e as ExitSentinel);
          return;
        }
        resolve(new Error("handler returned"));
      });
    });
    proxy.listen(port, "127.0.0.1");

    const result = await outcome;
    expect(result).toBeInstanceOf(ExitSentinel);
    expect(t.exits).toEqual([1]);
    expect(t.lines[0]).toContain(`already listening on http://127.0.0.1:${port}`);
    // The store was constructed (it read), and nothing was written: the directory does not
    // even exist, because creation happens on the first flush and the exit path never flushes.
    expect(existsSync(usage) ? readdirSync(usage) : []).toEqual([]);
    expect(store.closed).toBe(false);
  });
});
