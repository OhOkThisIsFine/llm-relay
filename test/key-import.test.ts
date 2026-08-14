import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import {
  importKeysFromFile,
  parseCredentialImport,
  parseFreeLlmApiExportJson,
} from "../src/key-import.js";

const CFG = {
  listen: "127.0.0.1:8791",
  mode: "detect",
  providers: {
    gemini: { base: "https://gemini.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" },
    groq: { base: "https://groq.test/v1", kind: "openai", authEnv: "GROQ_API_KEY" },
  },
  routing: { default: "gemini/model" },
} as unknown as Config;

describe("onboard --import parsers", () => {
  it("parses dotenv KEY=value lines without inspecting value shape", () => {
    expect(parseCredentialImport("# keys\nGOOGLE_API_KEY=ordinary-words\nGROQ_KEY='g-value'\n")).toEqual({
      format: "dotenv",
      entries: [
        { name: "GOOGLE_API_KEY", value: "ordinary-words" },
        { name: "GROQ_KEY", value: "g-value" },
      ],
    });
  });

  it("parses only the documented FreeLLMAPI export JSON envelope", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "2026-08-14T00:00:00Z",
      source: "freellmapi",
      keys: [
        { platform: "google", key: "google-secret", label: "Google" },
        { platform: "groq", key: "groq-secret", label: "Groq" },
      ],
    });
    expect(parseFreeLlmApiExportJson(text)).toEqual([
      { name: "google", value: "google-secret" },
      { name: "groq", value: "groq-secret" },
    ]);
    expect(() => parseCredentialImport('{"keys":[{"platform":"groq","key":"secret"}]}')).toThrow(
      /FreeLLMAPI v1 export/,
    );
  });
});

describe("onboard --import name resolution and persistence", () => {
  let dir: string;
  let envPath: string;
  let importPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-key-import-"));
    envPath = join(dir, ".env");
    importPath = join(dir, "keys.env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves closed aliases, explains unknown names, preserves existing entries, and never prints values", () => {
    const existingSecret = "existing-groq-secret";
    const replacementSecret = "replacement-groq-secret";
    const importedSecret = "imported-google-secret";
    const unknownSecret = "unknown-provider-secret";
    writeFileSync(envPath, `GROQ_API_KEY="${existingSecret}"\n`);
    writeFileSync(
      importPath,
      [
        `GOOGLE_API_KEY=${importedSecret}`,
        `GROQ_KEY=${replacementSecret}`,
        `MYSTERY_API_KEY=${unknownSecret}`,
      ].join("\n"),
    );
    const output: string[] = [];

    const result = importKeysFromFile(importPath, CFG, { envPath, writeLine: (line) => output.push(line) });
    const stored = readFileSync(envPath, "utf8");
    const rendered = output.join("\n");

    expect(result.outcomes).toEqual([
      { name: "GOOGLE_API_KEY", provider: "gemini", envName: "GEMINI_API_KEY", outcome: "imported" },
      {
        name: "GROQ_KEY",
        provider: "groq",
        envName: "GROQ_API_KEY",
        outcome: "skipped",
        reason: "already set in the destination .env (use --force to replace)",
      },
      {
        name: "MYSTERY_API_KEY",
        outcome: "skipped",
        reason: "unknown name (not in the closed provider alias list)",
      },
    ]);
    expect(stored).toContain(`GROQ_API_KEY="${existingSecret}"`);
    expect(stored).not.toContain(replacementSecret);
    expect(stored).toContain(`GEMINI_API_KEY="${importedSecret}"`);
    expect(rendered).toContain("Imported GOOGLE_API_KEY -> gemini as $GEMINI_API_KEY");
    expect(rendered).toContain("Skipped MYSTERY_API_KEY: unknown name");
    for (const secret of [existingSecret, replacementSecret, importedSecret, unknownSecret]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("imports supported FreeLLMAPI platform aliases and skips unsupported ones", () => {
    writeFileSync(
      importPath,
      JSON.stringify({
        version: 1,
        exportedAt: "2026-08-14T00:00:00Z",
        source: "freellmapi",
        keys: [
          { platform: "google", key: "google-secret", label: "Google" },
          { platform: "github", key: "github-secret", label: "GitHub" },
        ],
      }),
    );
    const output: string[] = [];

    const result = importKeysFromFile(importPath, CFG, { envPath, writeLine: (line) => output.push(line) });

    expect(result.format).toBe("freellmapi-json");
    expect(result.outcomes.map(({ name, outcome, provider, reason }) => ({ name, outcome, provider, reason }))).toEqual([
      { name: "google", outcome: "imported", provider: "gemini", reason: undefined },
      {
        name: "github",
        outcome: "skipped",
        provider: undefined,
        reason: "unknown name (not in the closed provider alias list)",
      },
    ]);
    expect(output.join("\n")).not.toMatch(/google-secret|github-secret/);
  });

  it("allows an explicit --force replacement through the same append-only env writer", () => {
    writeFileSync(envPath, 'GROQ_API_KEY="old"\n');
    writeFileSync(importPath, "GROQ_KEY=new\n");

    importKeysFromFile(importPath, CFG, { envPath, force: true, writeLine: () => undefined });

    const stored = readFileSync(envPath, "utf8");
    expect(stored.indexOf('GROQ_API_KEY="old"')).toBeLessThan(stored.indexOf('GROQ_API_KEY="new"'));
  });
});
