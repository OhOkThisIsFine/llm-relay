import { describe, it, expect } from "vitest";
import { parseRegQuery, recoverWindowsEnv } from "../src/winenv.js";

/**
 * Recovering credentials a long-running process never received.
 *
 * The failure this prevents: on Windows a User-scope variable enters a process's environment only
 * when that process STARTS. The relay is launched once at logon and runs for days, so a key added
 * afterwards is invisible to it — while every shell the user opens has it. Six providers answered
 * `401 Wrong API Key` / `no api key supplied` with perfectly good keys sitting in the registry,
 * and `llm-relay keys` (a fresh process) reported them as present, so every surface disagreed with
 * the one process that mattered.
 */
describe("parseRegQuery", () => {
  it("reads REG_SZ and REG_EXPAND_SZ rows, keeping values that contain spaces", () => {
    const out = parseRegQuery(
      [
        "",
        "HKEY_CURRENT_USER\\Environment",
        "    GROQ_API_KEY    REG_SZ    gsk_abc123",
        "    SOME_PATH    REG_EXPAND_SZ    C:\\Program Files\\Thing",
        "",
      ].join("\r\n"),
    );
    expect(out.GROQ_API_KEY).toBe("gsk_abc123");
    expect(out.SOME_PATH).toBe("C:\\Program Files\\Thing");
  });

  it("ignores headers, blanks and empty values", () => {
    const out = parseRegQuery("HKEY_CURRENT_USER\\Environment\r\n    EMPTY    REG_SZ    \r\n\r\n");
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("recoverWindowsEnv", () => {
  const read = (vals: Record<string, string>) => () => vals;

  it("fills only variables that are missing", () => {
    const env: NodeJS.ProcessEnv = { ALREADY: "from-launcher" };
    const r = recoverWindowsEnv(env, { platform: "win32", read: read({ ALREADY: "from-registry", MISSING: "recovered" }) });
    expect(env.MISSING).toBe("recovered");
    expect(env.ALREADY).toBe("from-launcher"); // the real environment is the more explicit signal
    expect(r.loaded).toContain("MISSING");
    expect(r.skipped).toContain("ALREADY");
  });

  it("treats a whitespace-only variable as absent, so it cannot shadow a real key", () => {
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: "   " };
    recoverWindowsEnv(env, { platform: "win32", read: read({ GROQ_API_KEY: "gsk_real" }) });
    expect(env.GROQ_API_KEY).toBe("gsk_real");
  });

  it("lets User scope win case-insensitively while preserving its key spelling", () => {
    const env: NodeJS.ProcessEnv = {};
    const readScopes = (key: string): Record<string, string> => key.startsWith("HKLM")
      ? { PROVIDER_KEY: "machine-value", PATH: "C:\\machine" }
      : { Provider_Key: "user-value", Path: "C:\\user-fragment" };

    recoverWindowsEnv(env, { platform: "win32", read: readScopes });

    const readCaseInsensitive = (name: string): string | undefined => {
      const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
      return match ? env[match] : undefined;
    };
    expect(readCaseInsensitive("PROVIDER_KEY")).toBe("user-value");
    expect(Object.keys(env)).toContain("Provider_Key");
    expect(Object.keys(env)).not.toContain("PROVIDER_KEY");
    expect(readCaseInsensitive("PATH")).toBeUndefined();
  });

  it("checks an existing launcher environment case-insensitively", () => {
    const env: NodeJS.ProcessEnv = { Provider_Key: "from-launcher" };
    const r = recoverWindowsEnv(env, {
      platform: "win32",
      read: read({ PROVIDER_KEY: "from-registry" }),
    });

    expect(env.Provider_Key).toBe("from-launcher");
    expect(env.PROVIDER_KEY).toBeUndefined();
    expect(r.skipped).toContain("PROVIDER_KEY");
  });

  it("NEVER imports PATH — the User scope holds a fragment, not the effective value", () => {
    // Importing it wholesale replaces a complete PATH with a partial one and breaks executable
    // lookup; `node.exe` stops resolving. Measured the hard way.
    const env: NodeJS.ProcessEnv = {};
    recoverWindowsEnv(env, { platform: "win32", read: read({ PATH: "C:\\only\\user\\bit", PATHEXT: ".COM", KEEP: "yes" }) });
    expect(env.PATH).toBeUndefined();
    expect(env.PATHEXT).toBeUndefined();
    expect(env.KEEP).toBe("yes");
  });

  it("is a no-op off Windows", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = recoverWindowsEnv(env, { platform: "linux", read: read({ ANYTHING: "x" }) });
    expect(r.skippedPlatform).toBe(true);
    expect(env.ANYTHING).toBeUndefined();
  });

  /**
   * ⚠ The guard this pins is why the suite is hermetic AND why two CLI tests stopped flaking.
   *
   * `readScope` shells out to `reg query` TWICE with `timeout: 5000` each, on the `loadOrExit()`
   * path that `cli.test.ts`, `accounting-cli-lifecycle.test.ts`, `keys-cli.test.ts` and
   * `dashboard-cli.test.ts` all reach. vitest's default test budget is also 5000ms, so ONE
   * contended spawn eats a whole test: measured ~50-70ms idle but 2806-4045ms while the full
   * suite competed for process creation, with a run at 5265ms — the intermittent
   * "passes alone, fails under load" timeout. It also merged the developer's real registry
   * environment into the worker's `process.env`.
   *
   * Same shape as `secret-file-acl.ts` and `os-keyring.ts`: under VITEST the real child process is
   * skipped unless the seam is injected — and every test above injects `read`, so the merge/skip/
   * never-import policy stays fully covered. Only the literal `reg query` call is unreachable.
   */
  it("does not touch the real registry under vitest unless a reader is injected", () => {
    expect(process.env.VITEST).toBeDefined();
    const env: NodeJS.ProcessEnv = {};
    // No `read` — the production path. Must return empty without spawning anything.
    const r = recoverWindowsEnv(env, { platform: "win32" });
    expect(r).toEqual({ loaded: [], skipped: [], skippedPlatform: false });
    expect(Object.keys(env)).toHaveLength(0);

    // An injected reader still runs the whole policy, so nothing above loses coverage.
    const injected = recoverWindowsEnv({}, { platform: "win32", read: read({ SOME_KEY: "v" }) });
    expect(injected.loaded).toEqual(["SOME_KEY"]);
  });
});
