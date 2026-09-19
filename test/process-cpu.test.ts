import { describe, expect, it } from "vitest";
import {
  descendantsOf,
  parsePsCpuRows,
  parsePsTime,
  parseWindowsCpuRows,
  sumCpuMs,
  type ProcessCpuRow,
} from "../src/mcp/process-cpu.js";

describe("process CPU helpers", () => {
  it("finds roots and descendants without including unrelated processes", () => {
    const rows: ProcessCpuRow[] = [
      { pid: 10, ppid: 1, cpuMs: 100 },
      { pid: 11, ppid: 10, cpuMs: 200 },
      { pid: 12, ppid: 11, cpuMs: 300 },
      { pid: 20, ppid: 1, cpuMs: 400 },
    ];
    expect([...descendantsOf(rows, [10])].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(sumCpuMs(rows, [10])).toBe(600);
  });

  it("parses ps cumulative time in minute, hour and day forms", () => {
    expect(parsePsTime("01:02")).toBe(62_000);
    expect(parsePsTime("1:02:03")).toBe(3_723_000);
    expect(parsePsTime("2-03:04:05")).toBe(183_845_000);
    expect(parsePsTime("00:60")).toBeNull();
    expect(parsePsTime("n/a")).toBeNull();
  });

  it("parses a ps fixture and sums only the owned tree", () => {
    const rows = parsePsCpuRows([
      "  10     1 00:01",
      "  11    10 00:02",
      "  12    11 1:00:03",
      "  99     1 00:20",
      "",
    ].join("\n"));
    expect(sumCpuMs(rows, [10])).toBe(3_606_000);
  });

  it("parses PowerShell Win32_Process JSON including numeric strings", () => {
    const rows = parseWindowsCpuRows(JSON.stringify([
      {
        ProcessId: 10,
        ParentProcessId: 1,
        KernelModeTime: "10000000",
        UserModeTime: "20000000",
      },
      {
        ProcessId: 11,
        ParentProcessId: 10,
        KernelModeTime: 5_000_000,
        UserModeTime: 5_000_000,
      },
      {
        ProcessId: "bad",
        ParentProcessId: 1,
        KernelModeTime: 1,
        UserModeTime: 1,
      },
    ]));
    expect(rows).toEqual([
      { pid: 10, ppid: 1, cpuMs: 3_000 },
      { pid: 11, ppid: 10, cpuMs: 1_000 },
    ]);
    expect(sumCpuMs(rows, [10])).toBe(4_000);
  });

  it("returns null when no process in the snapshot belongs to the roots", () => {
    expect(sumCpuMs([{ pid: 50, ppid: 1, cpuMs: 100 }], [10])).toBeNull();
  });
});
