export const CALIBRATION_SCHEMA: string;
export const CALIBRATION_QUANTILES: readonly number[];
export const CAPABILITY_DIMENSIONS: readonly unknown[];
export const TASK_FIT_SIGNALS: readonly unknown[];
export const EFFORT_FLOORS: Readonly<Record<"low" | "medium" | "high" | "xhigh", number>>;
export const HYSTERESIS_POINTS: number;

export function deriveCalibration(models: Array<Record<string, unknown>>, generatedAt?: string): any;
export function resolveCalibration(
  models: Array<Record<string, unknown>>,
  previous: any,
  generatedAt?: string,
): any;
export function calibratedValue(value: unknown, anchors: unknown): number | null;
export function effortEligibility(strength: number, previous?: string[]): string[];
export function scoreModels<T extends Record<string, any>>(
  models: T[],
  calibration: any,
  previousModels?: Array<Record<string, unknown>>,
): T[];
