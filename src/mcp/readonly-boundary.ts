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
 * ⚠ POLICY DECISION, STATED (2026-09-10, needs-owner item). The two candidates were a separate
 * checkout and a read-only tool set. The tool set is chosen by the LANE, not by the relay — the
 * relay does not author the lane's `claude`/`codex` invocation beyond the configured template,
 * and a template is exactly the prompt-level advice that already failed three times. The relay CAN
 * decide a working directory, so the boundary is drawn there: `cwd` containment is the enforcement,
 * and the refusal text carries the operator's two escapes. This is the smallest safe default, not
 * a claim that it is sufficient on its own — a lane explicitly handed a checkout elsewhere can
 * still commit there, which is precisely what "reviews needing file access require a separate
 * checkout" means.
 */
import { resolve as resolvePath } from "node:path";

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
