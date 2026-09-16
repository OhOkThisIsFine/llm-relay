/**
 * The read-only dispatch boundary — a MECHANISM, not an instruction.
 *
 * WHY THIS EXISTS. Three measured cases, all of which a prompt failed to prevent:
 *
 * - 2026-09-04: a prompt said "do NOT edit any file"; the lane created a scratch parser in the
 *   caller's checkout before it timed out, caught only by `git status` afterwards.
 * - 2026-09-05: a lane told "do not edit any file; output a unified diff" edited a spec file and
 *   then REVERTED it in both worktree and index — after the orchestrating session had staged its
 *   own edit to the same file, so a commit landed with only its ledger half. A lane in the live
 *   checkout can silently undo STAGED work, not merely add scratch files.
 * - 2026-09-09: an independent READ-ONLY review returned after 1,151 s reporting a commit and push
 *   of nine of the caller's in-progress files.
 *
 * ⚠ So this module refuses rather than instructs. A read-only agent dispatch whose working
 * directory would sit inside the caller's tree is REFUSED up front, naming the two things the
 * operator can do instead: run it against a separate checkout, or use answer mode — which has no
 * filesystem access at all, because it posts straight to the relay and spawns no harness.
 *
 * ⚠ POLICY DECISION, STATED (2026-09-10, needs-owner item) — and EXTENDED 2026-09-15. The two
 * candidates were a separate checkout and a read-only tool set. The 2026-09-10 choice was the
 * checkout alone, on the argument that the tool set is chosen by the lane. That was measured
 * insufficient five days later: a review lane run with `readOnly: true` in a SEPARATE worktree
 * still made "three scratch edits to source files" to re-measure something, restoring each from a
 * backup — clean by luck, enforced by nothing (C:\Code\docs\backlog.md, 2026-09-15). So `readOnly`
 * now binds BOTH: the working directory (`readOnlyVerdict`, unchanged) AND the lane's tool set
 * (`readOnlyInvoke`), by rewriting the invocation the relay is about to spawn. The relay authors
 * that command line — it substitutes `{task}` and `{spec}` into the template already — so it can
 * also state the permission flags the lane's own CLI documents for read-only use.
 *
 * ⚠ Only where the lane's CLI DOCUMENTS such a binding. A lane kind with no command-line way to
 * restrict its tools (OpenCode sets permissions per agent in its own config; AGY's permission
 * flags are unverified here) is REFUSED for a read-only dispatch, naming the gap — never run
 * unbound under a flag that claims protection. That is the closed-vocabulary rule: an unhandled
 * lane kind falls to the WEAKER claim (cannot bind ⇒ do not run), never the stronger one.
 */
import { resolve as resolvePath } from "node:path";
import { laneOfRung } from "../lane-manifest.js";

/** Whether a dispatch was declared read-only, and what it was going to run. */
export interface ReadOnlyRequest {
  /** The caller declared this dispatch must not mutate anything. */
  readOnly: boolean;
  /** `"answer"` posts to the relay and spawns no harness, so it has no filesystem access. */
  mode: "agent" | "answer";
  /** The working directory the dispatch would use, before any default is applied. */
  cwd: string | undefined;
  /** The tree the caller is protecting — its own checkout. */
  callerRoot: string;
}

export type ReadOnlyVerdict = { ok: true; cwd: string } | { ok: false; refusal: string };

/**
 * Decide whether a read-only dispatch may proceed, and say why not when it may not.
 *
 * Containment is tested on RESOLVED paths with a separator boundary, never a bare `startsWith`:
 * `C:/caller/tree-other` shares a prefix with `C:/caller/tree` and is not inside it, and a literal
 * `..` segment resolves at the OS level before the comparison — the `checkCwd` defect closed
 * 2026-09-03 (docs/audit-findings-2026-09-03.md finding 1 / DR-002), applied here in the direction
 * where getting it wrong would WRONGLY PERMIT a mutation.
 *
 * Answer mode is always allowed: `startLane` skips the cwd/spawn path entirely for a `relay` rung
 * in answer mode, so there is no process and no working directory to confine.
 */
export function readOnlyVerdict(req: ReadOnlyRequest): ReadOnlyVerdict {
  if (!req.readOnly) return { ok: true, cwd: resolveReadOnlyCwd(req.cwd) };
  if (req.mode === "answer") return { ok: true, cwd: resolveReadOnlyCwd(req.cwd) };
  const cwd = resolveReadOnlyCwd(req.cwd, req.callerRoot);
  if (!isInside(cwd, req.callerRoot)) return { ok: true, cwd };
  return {
    ok: false,
    refusal:
      "dispatch refused: this dispatch is declared read-only, but its working directory " +
      `(${cwd}) is inside the caller's own tree (${resolvePath(req.callerRoot)}). A read-only lane's ` +
      "write tools would reach the files it is only reviewing — the measured case committed and " +
      "pushed the caller's in-progress work, and another silently reverted a staged file. Either " +
      "pass `cwd` pointing at a separate checkout, or use mode \"answer\", which posts straight to " +
      "the relay and spawns no harness so it cannot touch the filesystem at all.",
  };
}

/** Resolve the directory a dispatch will actually run in: the caller's `cwd`, else the default. */
export function resolveReadOnlyCwd(cwd: string | undefined, fallback?: string): string {
  return resolvePath(cwd ?? fallback ?? process.cwd());
}

/**
 * Is `candidate` the same as, or beneath, `root`? Both sides are resolved first and the comparison
 * is against a separator-terminated root, so a shared name prefix is not containment.
 */
function isInside(candidate: string, root: string): boolean {
  const c = normalize(candidate);
  const r = normalize(resolvePath(root));
  return c === r || c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** Separators unified; case folded on win32, where two spellings of one path are one directory. */
function normalize(p: string): string {
  let unified = p.split("\\").join("/");
  let end = unified.length;
  while (end > 0 && unified[end - 1] === "/") end -= 1;
  unified = unified.slice(0, end);
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

// ---------------------------------------------------------------------------------------------
// The TOOL half of the boundary: what a read-only lane may be handed to run.

/** A lane invocation as `dispatch.ts` renders it and `lane-runner.ts` spawns it. */
export interface LaneInvocation {
  command: string;
  args: string[];
  env?: Record<string, string | null>;
}

/**
 * Claude Code's read-only built-in tools. `Task`/`Agent` are excluded on purpose: a subagent is
 * another tool loop, and confining the parent says nothing about it. `WebFetch`/`WebSearch` read
 * the network, never the tree.
 */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

/**
 * The tools a read-only Claude lane is DENIED by name, over and above being absent from the allow
 * list. Belt and braces: `--tools` removes them from the model's view, `--permission-mode dontAsk`
 * auto-denies anything not allowed (MCP tools included), and this names the writers explicitly so
 * a future built-in that slips into the default set is still refused. Every first-party mutation
 * tool from `DEFAULT_DESTRUCTIVE` (`config.ts`) is here.
 */
export const CLAUDE_READ_ONLY_DENIED = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "Agent",
] as const;

/** The flags a read-only rewrite REPLACES on a Claude command line, each with its one value. */
const CLAUDE_PERMISSION_FLAGS = [
  "--permission-mode",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--dangerously-skip-permissions",
] as const;

/** Codex flags a read-only rewrite REPLACES: the sandbox choice and every bypass of it. */
const CODEX_VALUED_FLAGS = ["--sandbox", "-s"] as const;
const CODEX_BARE_FLAGS = ["--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo"] as const;

export type ReadOnlyInvokeVerdict =
  | { ok: true; invoke: LaneInvocation; binding: string }
  | { ok: false; reason: string };

/**
 * Rewrite a lane invocation so the lane's OWN CLI runs it read-only, or say why that cannot be
 * done for this lane kind. Pure over the invocation; never spawns, never reads config.
 *
 * - `claude`: the harness's documented flags. `--permission-mode dontAsk` (CLAUDE.md: "`dontAsk` for
 *   a read-only [lane] that fails loudly instead of silently" — NEVER `plan`, which a headless
 *   `claude -p` can never leave), `--tools` + `--allowedTools` narrowed to `CLAUDE_READ_ONLY_TOOLS`,
 *   and `--disallowedTools` naming the writers. Any permission flag the template carried is
 *   REPLACED, so `acceptEdits` and a wide allow list cannot survive beside the read-only set.
 * - `codex`: `--sandbox read-only`, Codex's documented read-only policy, with `--full-auto` and
 *   every bypass flag stripped. Enforcement is Codex's own sandbox; the relay states the policy.
 * - `opencode`: refused. Its tool permissions live per agent in its own `opencode.json`, which the
 *   relay neither owns nor can verify from a command line.
 * - `agy`: refused. Its permission flags are unverified here, and a denied tool discards its whole
 *   answer, so a bound AGY lane would return nothing where a claude lane returns a review.
 * - anything else: refused — an unrecognised binary is the unknown case, and unknown never claims.
 */
export function readOnlyInvoke(invoke: LaneInvocation): ReadOnlyInvokeVerdict {
  const kind = laneToolOf(invoke);
  switch (kind) {
    case "claude":
      return readOnlyClaude(invoke);
    case "codex":
      return readOnlyCodex(invoke);
    case "opencode":
      return {
        ok: false,
        reason:
          "readOnly cannot bind an OpenCode lane's tools: OpenCode sets tool permissions per agent in " +
          "its own opencode.json, and the relay has no command-line way to restrict them",
      };
    case "agy":
      return {
        ok: false,
        reason:
          "readOnly cannot bind an AGY lane's tools: the relay has no verified command-line way to " +
          "restrict them, and a denied AGY tool discards the whole answer",
      };
    case null:
      return {
        ok: false,
        reason: `readOnly cannot bind this lane's tools: "${invoke.command}" is not a lane binary the relay knows how to restrict`,
      };
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

type LaneTool = "claude" | "codex" | "opencode" | "agy";

/**
 * Which agent CLI an invocation runs, seeing through the `pwsh … lane-launch.ps1` wrapper the same
 * way `laneOfRung` does — and, unlike it, also recognising `claude` and `opencode`, which the
 * manifest's closed set (built for roster probing) never needed to name.
 */
function laneToolOf(invoke: LaneInvocation): LaneTool | null {
  const known = laneOfRung(invoke.command, invoke.args)?.lane;
  if (known === "agy" || known === "codex") return known;
  for (const token of [invoke.command, ...invoke.args]) {
    const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
    if (base === "claude") return "claude";
    if (base === "opencode") return "opencode";
  }
  return null;
}

/** Drop `flag` and its one value (or `flag=value`) wherever it appears. */
function withoutValuedFlag(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === flag) {
      i += 1;
      continue;
    }
    if (a.startsWith(`${flag}=`)) continue;
    out.push(a);
  }
  return out;
}

function readOnlyClaude(invoke: LaneInvocation): ReadOnlyInvokeVerdict {
  let args = invoke.args;
  for (const flag of CLAUDE_PERMISSION_FLAGS) {
    args = flag === "--dangerously-skip-permissions" ? args.filter((a) => a !== flag) : withoutValuedFlag(args, flag);
  }
  const allowed = CLAUDE_READ_ONLY_TOOLS.join(",");
  const denied = CLAUDE_READ_ONLY_DENIED.join(",");
  const bound = [
    ...args,
    "--permission-mode",
    "dontAsk",
    "--tools",
    allowed,
    "--allowedTools",
    allowed,
    "--disallowedTools",
    denied,
  ];
  return {
    ok: true,
    invoke: { ...invoke, args: bound },
    binding: `claude --permission-mode dontAsk --tools ${allowed} (denied: ${denied})`,
  };
}

function readOnlyCodex(invoke: LaneInvocation): ReadOnlyInvokeVerdict {
  let args = invoke.args;
  for (const flag of CODEX_VALUED_FLAGS) args = withoutValuedFlag(args, flag);
  args = args.filter((a) => !(CODEX_BARE_FLAGS as readonly string[]).includes(a));
  // Right after the `exec` subcommand when there is one, so the flag precedes the prompt positional.
  const at = args.indexOf("exec");
  const insertAt = at === -1 ? 0 : at + 1;
  const bound = [...args.slice(0, insertAt), "--sandbox", "read-only", ...args.slice(insertAt)];
  return {
    ok: true,
    invoke: { ...invoke, args: bound },
    binding: "codex --sandbox read-only (enforced by Codex's own sandbox policy)",
  };
}
