import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyCommand, dispatchDashboardOrProxy, openDashboardInBrowser, proxyUrl, runDashboardCommand, type DashboardProcessSpawner } from "../src/cli.js";
import type { Config } from "../src/config.js";
import { DASHBOARD_MEDIA_TYPE } from "../src/dashboard-contract.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";

const directories: string[] = [];
const BOOTSTRAP = "A".repeat(43);

function processSpawner(
  outcome: "success" | "error" | "nonzero" | "signal" | "hung",
  calls?: Array<unknown[]>,
  onKill?: () => void,
): DashboardProcessSpawner {
  return (command, args, options) => {
    calls?.push([command, args, options]);
    let onError: (() => void) | undefined;
    let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    queueMicrotask(() => {
      if (outcome === "hung") return;
      if (outcome === "error") onError?.();
      else onClose?.(outcome === "success" ? 0 : outcome === "signal" ? null : 1, outcome === "signal" ? "SIGTERM" : null);
    });
    function once(event: "error", listener: () => void): ReturnType<DashboardProcessSpawner>;
    function once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): ReturnType<DashboardProcessSpawner>;
    function once(
      event: "error" | "close",
      listener: (() => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
    ): ReturnType<DashboardProcessSpawner> {
      if (event === "error") onError = listener as () => void;
      else onClose = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      return process;
    }
    const process = {
      once,
      kill() {
        onKill?.();
        return true;
      },
    };
    return process;
  };
}

function config(host = "127.0.0.1"): Config {
  const directory = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-cli-"));
  directories.push(directory);
  const sourcePath = join(directory, "config.json");
  writeFileSync(sourcePath, "{}");
  return { host, port: 43110, sourcePath } as Config;
}

function bootstrap(expiresAt = "2030-01-01T00:00:00.000Z"): Response {
  return new Response(JSON.stringify({ schema: "dashboard.bootstrap.v1", bootstrap: BOOTSTRAP, expiresAt }), {
    status: 200,
    headers: { "content-type": DASHBOARD_MEDIA_TYPE },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dashboard CLI launcher", () => {
  it("sends the exact protected bootstrap request and opens only the one-use fragment", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let opened = "";
    await runDashboardCommand(config(), {
      fetch: async (input, init) => {
        calls.push([String(input), init]);
        return bootstrap();
      },
      openBrowser: (url) => { opened = url; },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("http://127.0.0.1:43110/dashboard/api/v1/bootstrap");
    const init = calls[0]?.[1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }));
    expect(init.headers).toMatchObject({ Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "application/json" });
    expect((init.headers as Record<string, string>)[CONTROL_AUTHORIZATION_HEADER]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened).toBe(`http://127.0.0.1:43110/dashboard/#bootstrap=${BOOTSTRAP}`);
  });

  it("uses bracketed IPv6 URLs and treats dashboard as read-only", async () => {
    let opened = "";
    await runDashboardCommand(config("::1"), {
      fetch: async () => bootstrap(), openBrowser: (url) => { opened = url; }, now: () => 0,
    });
    expect(proxyUrl({ host: "::1", port: 43110 }, "/dashboard/")).toBe("http://[::1]:43110/dashboard/");
    expect(opened.startsWith("http://[::1]:43110/dashboard/#bootstrap=")).toBe(true);
    expect(classifyCommand(["node", "cli.js", "dashboard"])).toBe("read-only");
  });

  it("dispatches dashboard before proxy, store, or signal lifecycle can start", async () => {
    let loaded = 0;
    let launched = 0;
    let fallback = 0;
    dispatchDashboardOrProxy("dashboard", {
      loadConfig: () => { loaded += 1; return config(); },
      runDashboard: async () => { launched += 1; },
      reportError: () => undefined,
      reportUnknownCommand: () => undefined,
      runProxy: () => { fallback += 1; },
      runMcpServer: () => undefined,
    });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect({ loaded, launched, fallback }).toEqual({ loaded: 1, launched: 1, fallback: 0 });
  });

  /**
   * ⚠ This is the END of `main`'s ladder: any positional no earlier branch claimed lands here, and
   * it used to mean "start the proxy". A mistyped command therefore started a second relay rather
   * than reporting the typo — `EADDRINUSE` where one was already running, silence where none was,
   * and in neither case anything saying the command was not understood.
   *
   * The guard reads `CLI_COMMAND_NAMES`, the set that already existed, so it is one shared check:
   * a KNOWN name still falls through to the proxy exactly as before, and no positional at all is
   * still the documented way to start it.
   */
  it("refuses an unknown command instead of silently starting the proxy", () => {
    const run = (positional: string | undefined) => {
      const seen: string[] = [];
      let fallback = 0;
      let served = 0;
      dispatchDashboardOrProxy(positional, {
        loadConfig: () => config(),
        runDashboard: async () => undefined,
        reportError: () => undefined,
        reportUnknownCommand: (name) => { seen.push(name); },
        runProxy: () => { fallback += 1; },
        runMcpServer: () => { served += 1; },
      });
      return { seen, fallback, served };
    };

    // A typo is refused, and NAMED — the whole diagnostic value.
    expect(run("dashbaord")).toEqual({ seen: ["dashbaord"], fallback: 0, served: 0 });
    expect(run("stats")).toEqual({ seen: ["stats"], fallback: 0, served: 0 });

    // No positional at all still starts the proxy: `llm-relay [options]` is the primary usage.
    expect(run(undefined)).toEqual({ seen: [], fallback: 1, served: 0 });

    // A KNOWN command that reaches the tail keeps falling through, so nothing that worked changes.
    // `onboard` is in CLI_COMMAND_NAMES and is claimed by an earlier branch in the real ladder;
    // reaching here directly proves the guard is gated on the name set, not on the ladder.
    expect(run("onboard")).toEqual({ seen: [], fallback: 1, served: 0 });

    // WARNING: `mcp` is in CLI_COMMAND_NAMES, so without its own branch it would be a KNOWN name
    // that falls through to `runProxy()` — a host wiring up the MCP server would silently start a
    // SECOND relay on the configured port. It must serve MCP and start no proxy.
    expect(run("mcp")).toEqual({ seen: [], fallback: 0, served: 1 });
  });

  it("waits for native opener success and rejects spawn/nonzero failures", async () => {
    const calls: Array<unknown[]> = [];
    await expect(openDashboardInBrowser("http://127.0.0.1:1/dashboard/", "linux", processSpawner("success", calls))).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["xdg-open", ["http://127.0.0.1:1/dashboard/"], expect.objectContaining({ shell: false })]);
    await expect(openDashboardInBrowser("http://127.0.0.1:1/dashboard/", "linux", processSpawner("error"))).rejects.toThrow(/unavailable/);
    await expect(openDashboardInBrowser("http://127.0.0.1:1/dashboard/", "linux", processSpawner("nonzero"))).rejects.toThrow(/failed/);
    await expect(openDashboardInBrowser("http://127.0.0.1:1/dashboard/", "linux", processSpawner("signal"))).rejects.toThrow(/failed/);
  });

  it("terminates a hung native opener on timeout and falls back to the one-use link", async () => {
    let kills = 0;
    let output = "";
    await runDashboardCommand(config(), {
      fetch: async () => bootstrap(),
      openBrowser: (url) => openDashboardInBrowser(url, "linux", processSpawner("hung", undefined, () => { kills += 1; }), 1),
      write: (message) => { output += message; },
      now: () => 0,
    });
    expect(kills).toBe(1);
    expect(output).toContain(`#bootstrap=${BOOTSTRAP}`);
  });

  it("rejects bad status, media, schema, expiry, and noncanonical bootstrap capabilities", async () => {
    const badResponses = [
      new Response("no", { status: 403, headers: { "content-type": DASHBOARD_MEDIA_TYPE } }),
      new Response(JSON.stringify({ schema: "dashboard.bootstrap.v1", bootstrap: BOOTSTRAP, expiresAt: "2030-01-01T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ schema: "other", bootstrap: BOOTSTRAP, expiresAt: "2030-01-01T00:00:00.000Z" }), { status: 200, headers: { "content-type": DASHBOARD_MEDIA_TYPE } }),
      bootstrap("2020-01-01T00:00:00.000Z"),
      ...["", "has space", "has/slash", "has\u0000control", "\ud800", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}B`].map((bootstrapToken) =>
        new Response(JSON.stringify({ schema: "dashboard.bootstrap.v1", bootstrap: bootstrapToken, expiresAt: "2030-01-01T00:00:00.000Z" }), {
          status: 200, headers: { "content-type": DASHBOARD_MEDIA_TYPE },
        }),
      ),
    ];
    for (const response of badResponses) {
      await expect(runDashboardCommand(config(), { fetch: async () => response, now: () => Date.parse("2025-01-01T00:00:00.000Z") }))
        .rejects.toThrow(/dashboard bootstrap|rejected/i);
    }
  });

  it("prints a one-use fallback only when the browser opener fails, never the persistent token", async () => {
    let output = "";
    let controlToken = "";
    await runDashboardCommand(config(), {
      fetch: async (_input, init) => {
        controlToken = (init?.headers as Record<string, string>)[CONTROL_AUTHORIZATION_HEADER] ?? "";
        return bootstrap();
      },
      openBrowser: () => { throw new Error("not available"); },
      write: (message) => { output += message; },
      now: () => 0,
    });
    expect(output).toContain("one-use link");
    expect(output).toContain("#bootstrap=");
    expect(output).not.toContain(controlToken);
  });

  it("keeps the persistent control capability out of bootstrap errors and output", async () => {
    let controlToken = "";
    let output = "";
    const failure = await runDashboardCommand(config(), {
      fetch: async (_input, init) => {
        controlToken = (init?.headers as Record<string, string>)[CONTROL_AUTHORIZATION_HEADER] ?? "";
        return new Response(JSON.stringify({ schema: "dashboard.bootstrap.v1", bootstrap: "invalid", expiresAt: "2030-01-01T00:00:00.000Z" }), {
          status: 200, headers: { "content-type": DASHBOARD_MEDIA_TYPE },
        });
      },
      write: (message) => { output += message; },
      now: () => 0,
    }).then(() => "unexpected", (error: Error) => error.message);
    expect(controlToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(failure).not.toContain(controlToken);
    expect(output).not.toContain(controlToken);
  });

  it("falls back when the native helper exits nonzero", async () => {
    let output = "";
    await runDashboardCommand(config(), {
      fetch: async () => bootstrap(),
      openBrowser: (url) => openDashboardInBrowser(url, "linux", processSpawner("nonzero")),
      write: (message) => { output += message; },
      now: () => 0,
    });
    expect(output).toContain(`#bootstrap=${BOOTSTRAP}`);
  });
});
