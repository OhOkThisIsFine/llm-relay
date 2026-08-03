import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROL_AUTHORIZATION_FILENAME,
  CONTROL_AUTHORIZATION_HEADER,
  ControlAuthorizationError,
  createControlAuthorization,
  readControlAuthorizationHeader,
  resolveControlAuthorizationConfigDir,
  validateControlAuthorization,
  type ControlAuthorizationPort,
} from "../src/control-authorization.js";

const root = mkdtempSync(join(tmpdir(), "llm-relay-control-auth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function installDir(name: string): string {
  return join(root, name);
}

function installedToken(dir: string): string {
  const raw = readFileSync(join(dir, CONTROL_AUTHORIZATION_FILENAME), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  return raw.slice(0, -1);
}

describe("per-install control authorization", () => {
  it("creates an unguessable capability once and keeps it stable across reloads", () => {
    const dir = installDir("stable");
    const first = createControlAuthorization(dir);
    const token = installedToken(dir);
    const before = statSync(join(dir, CONTROL_AUTHORIZATION_FILENAME));

    const second = createControlAuthorization(dir);
    const after = statSync(join(dir, CONTROL_AUTHORIZATION_FILENAME));

    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.validate(token)).toBe(true);
    expect(second.validate(token)).toBe(true);
    expect(installedToken(dir)).toBe(token);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(after.mode & 0o777).toBe(0o600);
    }
  });

  it("uses independent capabilities for distinct config directories", () => {
    const leftDir = installDir("left");
    const rightDir = installDir("right");
    const left = createControlAuthorization(leftDir);
    const right = createControlAuthorization(rightDir);
    const leftToken = installedToken(leftDir);
    const rightToken = installedToken(rightDir);

    expect(leftToken).not.toBe(rightToken);
    expect(left.validate(rightToken)).toBe(false);
    expect(right.validate(leftToken)).toBe(false);
  });

  it("accepts only the exact token and rejects missing, malformed, and wrong candidates", () => {
    const dir = installDir("validation");
    const authorization = createControlAuthorization(dir);
    const token = installedToken(dir);

    expect(authorization.validate(token)).toBe(true);
    expect(authorization.validate(undefined)).toBe(false);
    expect(authorization.validate(null)).toBe(false);
    expect(authorization.validate([token])).toBe(false);
    expect(authorization.validate("")).toBe(false);
    expect(authorization.validate("short")).toBe(false);
    expect(authorization.validate(`${token} `)).toBe(false);
    expect(authorization.validate("x".repeat(token.length))).toBe(false);
    expect(authorization.validate("x".repeat(token.length * 2))).toBe(false);
  });

  it("reads Node and WHATWG-style headers case-insensitively and fails closed without a port", () => {
    const dir = installDir("headers");
    const authorization = createControlAuthorization(dir);
    const token = installedToken(dir);
    const record = { [CONTROL_AUTHORIZATION_HEADER.toUpperCase()]: token };
    const whatwg = new Headers({ [CONTROL_AUTHORIZATION_HEADER]: token });

    expect(readControlAuthorizationHeader(record)).toBe(token);
    expect(readControlAuthorizationHeader(whatwg)).toBe(token);
    expect(authorization.validateHeaders(record)).toBe(true);
    expect(validateControlAuthorization(authorization, whatwg)).toBe(true);
    expect(validateControlAuthorization(undefined, whatwg)).toBe(false);
    expect(validateControlAuthorization(authorization, {
      [CONTROL_AUTHORIZATION_HEADER]: [token, "duplicate"],
    })).toBe(false);
  });

  it("attaches for CLI use without mutation or duplicate differently-cased headers", () => {
    const dir = installDir("attach");
    const authorization = createControlAuthorization(dir);
    const base = {
      "content-type": "application/json",
      [CONTROL_AUTHORIZATION_HEADER.toUpperCase()]: "caller-supplied",
    };

    const attached = authorization.attach(base);

    expect(base[CONTROL_AUTHORIZATION_HEADER.toUpperCase()]).toBe("caller-supplied");
    expect(attached["content-type"]).toBe("application/json");
    expect(Object.keys(attached).filter(
      (name) => name.toLowerCase() === CONTROL_AUTHORIZATION_HEADER,
    )).toEqual([CONTROL_AUTHORIZATION_HEADER]);
    expect(authorization.validate(attached[CONTROL_AUTHORIZATION_HEADER])).toBe(true);
  });

  it("resolves config source directories consistently and permits an injected fallback", () => {
    const source = join(root, "explicit", "relay.json");
    const fallback = join(root, "fallback");

    expect(resolveControlAuthorizationConfigDir(source)).toBe(dirname(resolve(source)));
    expect(resolveControlAuthorizationConfigDir(undefined, fallback)).toBe(resolve(fallback));
  });

  it("never serializes capability material or includes corrupt file contents in errors", () => {
    const validDir = installDir("snapshot");
    const authorization = createControlAuthorization(validDir);
    const token = installedToken(validDir);
    const publicSnapshot = JSON.stringify(authorization);

    expect(publicSnapshot).toBe(JSON.stringify({ headerName: CONTROL_AUTHORIZATION_HEADER }));
    expect(publicSnapshot).not.toContain(token);

    const corruptDir = installDir("corrupt");
    createControlAuthorization(corruptDir);
    const sentinel = "SENTINEL_CONTROL_SECRET_MUST_NOT_LEAK";
    writeFileSync(join(corruptDir, CONTROL_AUTHORIZATION_FILENAME), sentinel, "utf8");
    let caught: unknown;
    try {
      createControlAuthorization(corruptDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ControlAuthorizationError);
    expect(String(caught)).not.toContain(sentinel);
  });

  it("publishes one complete winner under concurrent process startup", async () => {
    const dir = installDir("race");
    const moduleUrl = pathToFileURL(resolve("src/control-authorization.ts")).href;
    const script = [
      `import { createHash } from "node:crypto";`,
      `import { createControlAuthorization, CONTROL_AUTHORIZATION_HEADER } from ${JSON.stringify(moduleUrl)};`,
      `const auth = createControlAuthorization(${JSON.stringify(dir)});`,
      `const token = auth.attach()[CONTROL_AUTHORIZATION_HEADER];`,
      `process.stdout.write(createHash("sha256").update(token).digest("hex"));`,
    ].join("\n");

    const children = Array.from({ length: 6 }, () => new Promise<string>((resolveChild, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        "--input-type=module",
        "--eval", script,
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolveChild(stdout);
        else reject(new Error(`control authorization child failed (${code}): ${stderr}`));
      });
    }));

    const digests = await Promise.all(children);
    expect(new Set(digests).size).toBe(1);
    expect(Buffer.from(installedToken(dir), "base64url")).toHaveLength(32);
    expect(readdirSync(dir)).toEqual([CONTROL_AUTHORIZATION_FILENAME]);
  }, 20_000);

  it("supports narrow injected test doubles", () => {
    const port: ControlAuthorizationPort = { validate: (candidate) => candidate === "accepted" };
    expect(validateControlAuthorization(port, { [CONTROL_AUTHORIZATION_HEADER]: "accepted" })).toBe(true);
    expect(validateControlAuthorization(port, { [CONTROL_AUTHORIZATION_HEADER]: "rejected" })).toBe(false);
    expect(validateControlAuthorization({ validate: () => { throw new Error("unavailable"); } }, {
      [CONTROL_AUTHORIZATION_HEADER]: "accepted",
    })).toBe(false);
  });
});
