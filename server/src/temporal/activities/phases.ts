import {
  runSpecPhase as runSpecPhaseImpl,
  specPhaseInputSchema,
} from "../../agents/spec/activity.js";
import type { SpecPhaseInput } from "../../agents/spec/activity.js";
import {
  runCoderPhase as runCoderPhaseImpl,
  coderPhaseInputSchema,
} from "../../agents/coder/activity.js";
import type { CoderPhaseInput } from "../../agents/coder/activity.js";
import { runReviewAgent } from "../../agents/review/activity.js";

export { specPhaseInputSchema, coderPhaseInputSchema };
export type { SpecPhaseInput, CoderPhaseInput };

// Real spec activity body lives in `agents/spec/activity.ts`. Re-exported here
// so the worker registry / dispatch wiring keeps importing from the same path.
export const runSpecPhase = runSpecPhaseImpl;

// Real coder activity body lives in `agents/coder/activity.ts`. Re-exported
// here so the worker registry sees `runCoderPhase` from the same module as
// the other phase activities.
export const runCoderPhase = runCoderPhaseImpl;

// Real review activity body lives in `agents/review/activity.ts`. Re-exported
// here so the worker registry sees `runReviewPhase` from the same module as
// the other phase activities.
export const runReviewPhase = runReviewAgent;
