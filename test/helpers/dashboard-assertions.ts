import { expect } from "vitest";
import {
  assertDashboardErrorV1,
  assertDetailV1,
  assertSnapshotV1,
  isDashboardSnapshotV1,
  isDashboardDetailV1,
  isDashboardErrorV1,
  type SnapshotV1,
  type DetailV1,
  type DashboardErrorV1,
} from "../../src/dashboard-contract.js";

/**
 * Asserts that a value strictly satisfies the SnapshotV1 contract schema.
 */
export function expectValidSnapshotV1(value: unknown): asserts value is SnapshotV1 {
  expect(isDashboardSnapshotV1(value)).toBe(true);
  expect(() => assertSnapshotV1(value)).not.toThrow();
}

/**
 * Asserts that a value strictly satisfies the DetailV1 contract schema.
 */
export function expectValidDetailV1(value: unknown): asserts value is DetailV1 {
  expect(isDashboardDetailV1(value)).toBe(true);
  expect(() => assertDetailV1(value)).not.toThrow();
}

/**
 * Asserts that a value strictly satisfies the DashboardErrorV1 contract schema.
 */
export function expectValidDashboardErrorV1(value: unknown): asserts value is DashboardErrorV1 {
  expect(isDashboardErrorV1(value)).toBe(true);
  expect(() => assertDashboardErrorV1(value)).not.toThrow();
}

/**
 * Asserts that an HTTP response has dashboard headers and valid JSON payload.
 */
export async function expectDashboardResponse<T>(
  response: Response,
  expectedStatus = 200,
): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  const contentType = response.headers.get("content-type");
  expect(contentType).toContain("application/json");
  const data = (await response.json()) as T;
  return data;
}
