/**
 * Pure capability-scoring policy used by sync-tiers.mjs.
 *
 * The scorer deliberately separates three questions that used to be conflated:
 *   - capability: fixed agentic/coding/general dimensions;
 *   - evidence: how much of that score was measured rather than estimated;
 *   - behaviour: protocol/relevance signals that help order deployments but do not grant a tier.
 *
 * Keeping this module free of I/O makes the policy deterministic and directly testable.
 */

export const CALIBRATION_SCHEMA = "anchored-quantiles/v1";
export const CALIBRATION_QUANTILES = Object.freeze([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]);

export const CAPABILITY_DIMENSIONS = Object.freeze([
  Object.freeze({
    name: "agentic",
    weight: 0.40,
    signals: Object.freeze([
      "aa_agentic",
      "bfcl_overall",
    ]),
  }),
  Object.freeze({
    name: "coding",
    weight: 0.35,
    signals: Object.freeze(["aa_coding", "aider_pass_rate"]),
  }),
  Object.freeze({
    name: "general",
    weight: 0.25,
    signals: Object.freeze(["aa_intelligence", "arena_rating"]),
  }),
]);

export const TASK_FIT_SIGNALS = Object.freeze([
  Object.freeze({
    field: "design_arena_agents_elo_mean",
    note: "specialized design-agent task performance",
  }),
  Object.freeze({ field: "bfcl_irrelevance", note: "declines when no tool fits" }),
  Object.freeze({ field: "aider_well_formed", note: "edit-format compliance" }),
]);

export const EFFORT_FLOORS = Object.freeze({ low: 50, medium: 60, high: 70, xhigh: 80 });
export const HYSTERESIS_POINTS = 2;

const CAPABILITY_FIELDS = Object.freeze(
  CAPABILITY_DIMENSIONS.flatMap((dimension) => dimension.signals),
);
const CALIBRATED_FIELDS = Object.freeze([
  ...CAPABILITY_FIELDS,
  ...TASK_FIT_SIGNALS.map((signal) => signal.field),
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Linear-interpolated quantile for an ascending numeric array. */
function quantile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const position = clamp01(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/**
 * Bootstrap stable raw-value anchors. The snapshot persists these anchors and later syncs reuse
 * them, so a leaderboard adding unrelated rows cannot silently move every existing model.
 */
export function deriveCalibration(models, generatedAt = new Date().toISOString()) {
  const fields = {};
  for (const field of CALIBRATED_FIELDS) {
    const values = models.map((model) => model[field]).filter(finite).sort((a, b) => a - b);
    if (values.length === 0) continue;
    fields[field] = CALIBRATION_QUANTILES.map((percentile) => ({
      percentile,
      value: quantile(values, percentile),
    }));
  }
  return {
    schema: CALIBRATION_SCHEMA,
    generated_at: generatedAt,
    quantiles: [...CALIBRATION_QUANTILES],
    fields,
  };
}

function validAnchors(anchors) {
  return Array.isArray(anchors) && anchors.length >= 2 && anchors.every((anchor, index) =>
    anchor && finite(anchor.percentile) && finite(anchor.value) &&
    (index === 0 || (
      anchor.percentile > anchors[index - 1].percentile &&
      anchor.value >= anchors[index - 1].value
    )),
  );
}

/** Reuse persisted anchors field-by-field; bootstrap only new or invalid fields. */
export function resolveCalibration(models, previous, generatedAt = new Date().toISOString()) {
  const derived = deriveCalibration(models, generatedAt);
  if (previous?.schema !== CALIBRATION_SCHEMA || typeof previous.fields !== "object") return derived;

  const fields = {};
  for (const field of CALIBRATED_FIELDS) {
    const prior = previous.fields[field];
    const next = derived.fields[field];
    if (validAnchors(prior)) fields[field] = prior.map((anchor) => ({ ...anchor }));
    else if (next) fields[field] = next;
  }
  return {
    schema: CALIBRATION_SCHEMA,
    generated_at: previous.generated_at ?? generatedAt,
    quantiles: [...CALIBRATION_QUANTILES],
    fields,
  };
}

/** Map a raw benchmark measurement onto its persisted 0-1 capability scale. */
export function calibratedValue(value, anchors) {
  if (!finite(value) || !validAnchors(anchors)) return null;
  const tied = anchors.filter((anchor) => anchor.value === value);
  if (tied.length > 1) return mean(tied.map((anchor) => anchor.percentile));
  if (value <= anchors[0].value) return anchors[0].percentile;
  const last = anchors[anchors.length - 1];
  if (value >= last.value) return last.percentile;

  for (let index = 1; index < anchors.length; index++) {
    const upper = anchors[index];
    const lower = anchors[index - 1];
    if (value > upper.value) continue;
    if (upper.value === lower.value) return upper.percentile;
    const fraction = (value - lower.value) / (upper.value - lower.value);
    return lower.percentile + (upper.percentile - lower.percentile) * fraction;
  }
  return last.percentile;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let k = column; k <= n; k++) augmented[column][k] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let k = column; k <= n; k++) augmented[row][k] -= factor * augmented[column][k];
    }
  }
  return augmented.map((row) => row[n]);
}

/**
 * Ridge regression on centered 0-1 dimension scores. The small ridge prevents two strongly
 * correlated axes from producing explosive coefficients while leaving the intercept unpenalized.
 */
function fitEstimator(rows, target, predictors) {
  const training = rows.filter((row) =>
    finite(row.direct[target]) && predictors.every((predictor) => finite(row.direct[predictor])),
  );
  if (training.length < 12 || predictors.length === 0) return null;

  const targetMean = mean(training.map((row) => row.direct[target]));
  const predictorMeans = predictors.map((predictor) => mean(training.map((row) => row.direct[predictor])));
  const covariance = predictors.map((left, i) => predictors.map((right, j) =>
    mean(training.map((row) =>
      (row.direct[left] - predictorMeans[i]) * (row.direct[right] - predictorMeans[j]),
    )),
  ));
  const targetCovariance = predictors.map((predictor, i) => mean(training.map((row) =>
    (row.direct[predictor] - predictorMeans[i]) * (row.direct[target] - targetMean),
  )));
  const RIDGE = 0.01;
  for (let index = 0; index < predictors.length; index++) covariance[index][index] += RIDGE;
  const coefficients = solveLinearSystem(covariance, targetCovariance);
  if (!coefficients) return null;

  const predict = (direct) => clamp01(
    targetMean + coefficients.reduce(
      (sum, coefficient, index) => sum + coefficient * (direct[predictors[index]] - predictorMeans[index]),
      0,
    ),
  );
  const residual = training.reduce((sum, row) => sum + (row.direct[target] - predict(row.direct)) ** 2, 0);
  const total = training.reduce((sum, row) => sum + (row.direct[target] - targetMean) ** 2, 0);
  const rSquared = total > 0 ? clamp01(1 - residual / total) : 0;
  return { predict, trainingCount: training.length, rSquared };
}

function directScores(models, calibration) {
  return models.map((model) => {
    const calibrated = Object.fromEntries(CAPABILITY_FIELDS.map((field) => [
      field,
      calibratedValue(model[field], calibration.fields[field]),
    ]));
    const direct = {};
    const dimensionSignals = {};
    for (const dimension of CAPABILITY_DIMENSIONS) {
      const signals = dimension.signals.filter((field) => finite(calibrated[field]));
      const scores = signals.map((field) => calibrated[field]);
      direct[dimension.name] = mean(scores);
      dimensionSignals[dimension.name] = signals;
    }
    return { model, calibrated, direct, dimensionSignals };
  });
}

function previousEfforts(previousModels, norm) {
  const previous = previousModels?.find((model) => model?.norm === norm);
  return new Set(Array.isArray(previous?.effort_eligibility) ? previous.effort_eligibility : []);
}

/** Whole-point admission plus a two-point exit margin for already-admitted models. */
export function effortEligibility(strength, previous = []) {
  if (!finite(strength)) return [];
  const wholePointScore = Math.round(strength * 100);
  const prior = new Set(previous);
  return Object.entries(EFFORT_FLOORS)
    .filter(([effort, floor]) =>
      wholePointScore >= floor || (prior.has(effort) && wholePointScore >= floor - HYSTERESIS_POINTS),
    )
    .map(([effort]) => effort);
}

/**
 * Score models without coverage bias. Every model receives the same fixed dimension weights;
 * absent dimensions are predicted from overlapping models instead of disappearing from the
 * denominator. Prediction quality reduces confidence, never raw capability or tier eligibility.
 */
export function scoreModels(models, calibration, previousModels = []) {
  const rows = directScores(models, calibration);
  for (const row of rows) {
    const directDimensions = CAPABILITY_DIMENSIONS
      .map((dimension) => dimension.name)
      .filter((name) => finite(row.direct[name]));
    const imputedDimensions = CAPABILITY_DIMENSIONS
      .map((dimension) => dimension.name)
      .filter((name) => !finite(row.direct[name]));
    const dimensions = { ...row.direct };
    const imputationConfidence = {};

    for (const missing of imputedDimensions) {
      const estimator = fitEstimator(rows, missing, directDimensions);
      if (estimator) {
        dimensions[missing] = estimator.predict(row.direct);
        imputationConfidence[missing] = estimator.rSquared;
      } else {
        const observed = rows.map((candidate) => candidate.direct[missing]).filter(finite);
        dimensions[missing] = observed.length > 0
          ? quantile(observed.sort((a, b) => a - b), 0.5)
          : 0.5;
        imputationConfidence[missing] = 0;
      }
    }

    const capabilitySignals = CAPABILITY_DIMENSIONS.flatMap(
      (dimension) => row.dimensionSignals[dimension.name],
    );
    const taskFitSignals = TASK_FIT_SIGNALS
      .map((signal) => signal.field)
      .filter((field) => calibratedValue(row.model[field], calibration.fields[field]) !== null);
    const taskFitValues = taskFitSignals.map((field) =>
      calibratedValue(row.model[field], calibration.fields[field]),
    );
    const strength = directDimensions.length > 0
      ? CAPABILITY_DIMENSIONS.reduce(
          (sum, dimension) => sum + dimensions[dimension.name] * dimension.weight,
          0,
        )
      : null;

    const evidenceCoverage = Math.min(1, capabilitySignals.length / 5);
    const estimatedAxisCredit = imputedDimensions.reduce(
      (sum, dimension) => sum + 0.5 * (imputationConfidence[dimension] ?? 0),
      0,
    );
    const axisCoverage = (directDimensions.length + estimatedAxisCredit) / CAPABILITY_DIMENSIONS.length;
    const capabilityConfidence = directDimensions.length > 0
      ? clamp01(0.6 * axisCoverage + 0.4 * evidenceCoverage)
      : 0;
    const previous = previousEfforts(previousModels, row.model.norm);

    Object.assign(row.model, {
      strength: strength === null ? null : round3(strength),
      dimensions: Object.fromEntries(
        CAPABILITY_DIMENSIONS.map((dimension) => [dimension.name, round3(dimensions[dimension.name])]),
      ),
      direct_dimensions: directDimensions,
      imputed_dimensions: imputedDimensions,
      imputation_confidence: Object.fromEntries(
        Object.entries(imputationConfidence).map(([dimension, value]) => [dimension, round3(value)]),
      ),
      capability_confidence: round3(capabilityConfidence),
      signals: capabilitySignals,
      signal_count: capabilitySignals.length,
      task_fit_score: taskFitValues.length > 0 ? round3(mean(taskFitValues)) : null,
      task_fit_signals: taskFitSignals,
      task_fit_signal_count: taskFitSignals.length,
      published_signal_count: capabilitySignals.length + taskFitSignals.length,
      effort_eligibility: effortEligibility(strength, previous),
    });
  }
  return models;
}
