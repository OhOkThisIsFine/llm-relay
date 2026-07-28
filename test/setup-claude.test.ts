import { describe, it, expect } from "vitest";
import { getClaudeDesktopConfigPath, setupClaudeDesktop, setupClaudeCli } from "../src/setup-claude.js";

describe("setup-claude", () => {
  it("getClaudeDesktopConfigPath returns platform path", () => {
    const p = getClaudeDesktopConfigPath();
    expect(p).toContain("Claude");
    expect(p.endsWith("claude_desktop_config.json")).toBe(true);
  });

  it("setupClaudeCli returns success result", () => {
    const res = setupClaudeCli();
    expect(res.success).toBe(true);
    expect(res.message).toBeDefined();
  });

  it("setupClaudeDesktop writes/patches valid json config", () => {
    const res = setupClaudeDesktop();
    expect(res.success).toBe(true);
    expect(res.path).toBeDefined();
  });
});
