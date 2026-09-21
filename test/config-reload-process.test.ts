import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "llm-relay-reload-process-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["VITEST"];
  env["HOME"] = dir;
  env["USERPROFILE"] = dir;
  env["XDG_CONFIG_HOME"] = join(dir, "xdg-config");
  env["XDG_CACHE_HOME"] = join(dir, "xdg-cache");
  env["LLM_RELAY_NO_SELF_UPDATE"] = "1";
  return env;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test listener");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function configDocument(port: number, model: string, base = "http://127.0.0.1:1"): Record<string, unknown> {
  return {
    listen: `127.0.0.1:${port}`,
    providers: {
      p: {
        base,
        kind: "openai",
        timeoutMs: 2000,
      },
    },
    routing: { default: `p/${model}`, benchmarkSort: false },
    mode: "detect",
    log: { level: "silent", file: null },
  };
}

function writeConfig(path: string, body: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
}

async function waitFor(
  read: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function spawnDaemon(configPath: string): {
  child: ChildProcess;
  stderr: string[];
} {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, "--config", configPath], {
    cwd: process.cwd(),
    env: isolatedEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stderr };
}

async function runCli(configPath: string, command: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI, "--config", configPath, command],
    {
      cwd: process.cwd(),
      env: isolatedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function modelIds(base: string): Promise<string[]> {
  const response = await fetch(`${base}/v1/models`);
  expect(response.status).toBe(200);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((entry) => entry.id ?? "");
}

describe("D2 real daemon config reload", () => {
  it("keeps one daemon alive across a reload and refuses a restart-only edit atomically", async () => {
    const port = await freePort();
    const configPath = join(dir, `config-${port}.json`);
    writeConfig(configPath, configDocument(port, "model-a"));
    const daemon = spawnDaemon(configPath);
    const base = `http://127.0.0.1:${port}`;

    try {
      await waitFor(
        () => daemon.stderr.join("").includes("llm-relay listening on"),
        15_000,
        `daemon startup; stderr=${daemon.stderr.join("")}`,
      );
      const pid = daemon.child.pid;
      expect(pid).toBeTypeOf("number");
      expect(await modelIds(base)).toContain("p/model-a");

      writeConfig(configPath, configDocument(port, "model-b"));
      const accepted = await runCli(configPath, "reload");
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain("routing.default");
      expect(daemon.child.pid).toBe(pid);
      const afterAccepted = await modelIds(base);
      expect(afterAccepted).toContain("p/model-b");
      expect(afterAccepted).not.toContain("p/model-a");

      writeConfig(
        configPath,
        configDocument(port, "model-c", "http://127.0.0.1:2"),
      );
      const refused = await runCli(configPath, "reload");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("providers.p.base");
      expect(daemon.child.pid).toBe(pid);
      const afterRefused = await modelIds(base);
      expect(afterRefused).toContain("p/model-b");
      expect(afterRefused).not.toContain("p/model-c");
    } finally {
      if (daemon.child.exitCode === null) {
        daemon.child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            daemon.child.kill("SIGKILL");
            resolve();
          }, 5000);
          daemon.child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }, 30_000);
});
