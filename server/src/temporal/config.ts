export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
export const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "the-furnace";

// Keep this conservative: a single Claude subscription is shared by all activities.
// Bounding local activity concurrency prevents one worker from self-starving the quota.
export const CLAUDE_ACTIVITY_CONCURRENCY = Number(process.env.CLAUDE_ACTIVITY_CONCURRENCY ?? 2);
