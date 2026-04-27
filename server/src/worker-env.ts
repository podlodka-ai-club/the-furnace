export interface ContainerWorkerEnv {
  repo: string;
  languages: string[];
  tools: string[];
  attemptId: string | undefined;
  temporal: {
    address: string;
    namespace: string;
  };
}

export class MissingWorkerEnvError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Required environment variable ${variable} is unset`);
    this.name = "MissingWorkerEnvError";
    this.variable = variable;
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingWorkerEnvError(name);
  }
  return value;
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readContainerWorkerEnv(env: NodeJS.ProcessEnv = process.env): ContainerWorkerEnv {
  const repo = requireEnv(env, "WORKER_REPO");
  const address = requireEnv(env, "TEMPORAL_ADDRESS");
  const namespace = requireEnv(env, "TEMPORAL_NAMESPACE");

  return {
    repo,
    languages: readList(env, "WORKER_LANGUAGES"),
    tools: readList(env, "WORKER_TOOLS"),
    attemptId: env.WORKER_ATTEMPT_ID && env.WORKER_ATTEMPT_ID.length > 0 ? env.WORKER_ATTEMPT_ID : undefined,
    temporal: { address, namespace },
  };
}
