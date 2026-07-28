import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { argValue, hasFlag, splitSpec, main } from "../src/cli.js";

describe("cli helper utilities", () => {
  const origArgv = process.argv;

  beforeEach(() => {
    process.argv = [...origArgv];
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  it("splitSpec correctly parses provider and model", () => {
    expect(splitSpec("nim/meta/llama-3")).toEqual({ provider: "nim", model: "meta/llama-3" });
    expect(splitSpec("openai")).toEqual({ provider: "openai", model: undefined });
  });

  it("argValue extracts values with double dash --flag value", () => {
    process.argv = ["node", "cli.ts", "--config", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("argValue extracts values with single dash -flag value", () => {
    process.argv = ["node", "cli.ts", "-config", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("argValue extracts values with short flag -c value", () => {
    process.argv = ["node", "cli.ts", "-c", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("argValue extracts values with equals syntax --flag=value and -flag=value", () => {
    process.argv = ["node", "cli.ts", "--config=foo.json"];
    expect(argValue("--config", "-c")).toBe("foo.json");

    process.argv = ["node", "cli.ts", "-config=bar.json"];
    expect(argValue("--config", "-c")).toBe("bar.json");

    process.argv = ["node", "cli.ts", "-c=baz.json"];
    expect(argValue("--config", "-c")).toBe("baz.json");
  });

  it("hasFlag returns true for double dash, single dash, short form, and equals syntax", () => {
    process.argv = ["node", "cli.ts", "--refresh"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "-refresh"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "-r"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "--help=true"];
    expect(hasFlag("--help", "-h")).toBe(true);

    process.argv = ["node", "cli.ts", "-h"];
    expect(hasFlag("--help", "-h")).toBe(true);

    process.argv = ["node", "cli.ts", "--other"];
    expect(hasFlag("--refresh", "-r")).toBe(false);
  });

  it("main exits 0 and prints help when invoked with help or --help", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "help"];
    expect(() => main()).toThrow("exit:0");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("llm-relay — loopback Anthropic-Messages proxy"));

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("main exits 0 and prints version when invoked with version or --version", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "--version"];
    expect(() => main()).toThrow("exit:0");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
