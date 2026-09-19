/**
 * Process-tree CPU time as a lane liveness signal.
 *
 * A spawned lane that does not route model traffic through the relay (AGY, Codex, OpenCode) can
 * legitimately think for minutes without stdout or a file change. The dispatch walk therefore
 * samples cumulative CPU time for exactly the process tree it owns. An increase is evidence of
 * work; a flat value is not. The first sample is only a baseline and is interpreted by the caller.
 *
 * This module never decides whether a lane is idle. It only reads one monotonic measurement.
 * Under vitest the real reader returns null unless a caller injects another reader, so the suite
 * never enumerates the operator's live processes.
 */
import { execFile } from "node:child_process";

const CPU_READ_TIMEOUT_MS = 10_000;
const CPU_READ_MAX_BUFFER = 8 * 1024 * 1024;

export interface ProcessCpuRow {
  pid: number;
  ppid: number;
  cpuMs: number;
}

export type ProcessCpuReader = (rootPids: readonly number[]) => Promise<number | null>;

function finiteInteger(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Root pids plus every descendant reachable through parent-pid edges. */
export function descendantsOf(
  rows: readonly Pick<ProcessCpuRow, "pid" | "ppid">[],
  rootPids: readonly number[],
): Set<number> {
  const owned = new Set(rootPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  if (owned.size === 0) return owned;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.ppid) || owned.has(row.pid)) continue;
      owned.add(row.pid);
      changed = true;
    }
  }
  return owned;
}

/** Parse ps' [[dd-]hh:]mm:ss cumulative CPU-time form into milliseconds. */
export function parsePsTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  if (minutes >= 60 || seconds >= 60) return null;
  if (match[1] !== undefined && hours >= 24) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Sum cumulative CPU time for the roots and all descendants. Null means no matching process. */
export function sumCpuMs(rows: readonly ProcessCpuRow[], rootPids: readonly number[]): number | null {
  const owned = descendantsOf(rows, rootPids);
  let total = 0;
  let matched = 0;
  for (const row of rows) {
    if (!owned.has(row.pid) || !Number.isFinite(row.cpuMs) || row.cpuMs < 0) continue;
    total += row.cpuMs;
    matched += 1;
  }
  return matched === 0 ? null : total;
}

/** Parse PowerShell ConvertTo-Json output from Win32_Process. */
export function parseWindowsCpuRows(text: string): ProcessCpuRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const rows: ProcessCpuRow[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const pid = finiteInteger(row["ProcessId"]);
    const ppid = finiteInteger(row["ParentProcessId"]);
    const kernel100ns = finiteNonNegative(row["KernelModeTime"]);
    const user100ns = finiteNonNegative(row["UserModeTime"]);
    if (pid === null || pid <= 0 || ppid === null || kernel100ns === null || user100ns === null) continue;
    rows.push({ pid, ppid, cpuMs: (kernel100ns + user100ns) / 10_000 });
  }
  return rows;
}

/** Parse `ps -A -o pid=,ppid=,time=` output. */
export function parsePsCpuRows(text: string): ProcessCpuRow[] {
  const rows: ProcessCpuRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuMs = parsePsTime(match[3] ?? "");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || cpuMs === null) continue;
    rows.push({ pid, ppid, cpuMs });
  }
  return rows;
}

function runText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: CPU_READ_TIMEOUT_MS,
        maxBuffer: CPU_READ_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

const WINDOWS_QUERY =
  "Get-CimInstance Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | " +
  "ConvertTo-Json -Compress";

/** Real process-tree CPU reader. Null is no signal, never an idle verdict. */
export const defaultProcessCpuReader: ProcessCpuReader = async (rootPids) => {
  if (process.env["VITEST"]) return null;
  const roots = [...new Set(rootPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (roots.length === 0) return null;

  if (process.platform === "win32") {
    const stdout = await runText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY]);
    if (stdout === null) return null;
    return sumCpuMs(parseWindowsCpuRows(stdout), roots);
  }

  const stdout = await runText("ps", ["-A", "-o", "pid=,ppid=,time="]);
  if (stdout === null) return null;
  return sumCpuMs(parsePsCpuRows(stdout), roots);
};
