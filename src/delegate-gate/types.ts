/**
 * The shared vocabulary for the delegate-diff quality gate.
 *
 * A host dispatches work to an agent lane (see `dispatch.ts`/`lane-manifest.ts`); the lane
 * returns a unified diff. Before that diff reaches judgment or merge, this gate runs a small,
 * closed set of deterministic detectors over it and reports a structured verdict. Nothing here
 * talks to a model — same "repair boundary" reasoning as the rest of this repo: mechanical
 * checks on protocol/structure, never an opinion about whether the change is a good idea.
 */

/** The closed set of defect classes this gate looks for. Extend by adding a member here AND a
 * detector — nothing folds an unlisted class into an existing one. */
export const FINDING_CLASSES = [
  "indentation-churn",
  "non-minimal-diff",
  "tautological-assertion",
  "unnecessary-cast",
  "shared-state-mutation",
] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

export interface Finding {
  readonly class: FindingClass;
  /** Path as it appears in the diff (the new/post-image path for a modification or addition). */
  readonly file: string;
  /** 1-based line number in the POST-image the finding applies to. */
  readonly line: number;
  readonly detail: string;
  readonly autoFixable: boolean;
}

export interface Verdict {
  readonly pass: boolean;
  readonly findings: readonly Finding[];
}
