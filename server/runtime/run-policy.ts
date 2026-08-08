export const RUNTIME_RUN_MAX_JOBS = 100;
export const RUNTIME_RUN_MAX_RUNTIME_MS = 24 * 60 * 60 * 1_000;

export type RuntimeRunStopReason =
  | "dry_run"
  | "job_limit"
  | "runtime_limit"
  | "idle"
  | "once"
  | "signal"
  | "fatal";

export type RuntimeRunOptions = {
  once?: boolean;
  maxJobs?: number;
  maxRuntimeMs?: number;
  enrichmentOnly?: boolean;
  stopWhenIdle?: boolean;
};

export type RuntimeRunReceipt = {
  mode: "continuous" | "bounded";
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  maxJobs?: number;
  maxRuntimeMs?: number;
  enrichmentOnly: boolean;
  claimedJobs: number;
  succeededJobs: number;
  warningJobs: number;
  failedJobs: number;
  initialQueuedJobs?: number;
  remainingQueuedJobs?: number;
  stopReason: RuntimeRunStopReason;
};

const optionValue = (arguments_: readonly string[], name: string) => {
  const prefix = `${name}=`;
  const inline = arguments_.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};

const boundedInteger = (
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
) => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}은 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  return parsed;
};

export function parseRuntimeRunOptions(
  arguments_: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): RuntimeRunOptions {
  const once = arguments_.includes("--once");
  const batch = arguments_.includes("--batch");
  const maxJobs = boundedInteger(
    optionValue(arguments_, "--max-jobs") ?? environment.ATLAS_RUNTIME_MAX_JOBS ?? (batch ? "1" : undefined),
    "max jobs",
    0,
    RUNTIME_RUN_MAX_JOBS,
  );
  const maxRuntimeMs = boundedInteger(
    optionValue(arguments_, "--max-runtime-ms")
      ?? environment.ATLAS_RUNTIME_MAX_RUNTIME_MS
      ?? (batch ? "300000" : undefined),
    "max runtime",
    1_000,
    RUNTIME_RUN_MAX_RUNTIME_MS,
  );
  const bounded = once || batch || maxJobs !== undefined || maxRuntimeMs !== undefined;
  return {
    once,
    maxJobs: once && maxJobs === undefined ? 1 : maxJobs,
    maxRuntimeMs,
    enrichmentOnly: arguments_.includes("--enrichment-only"),
    stopWhenIdle: arguments_.includes("--stop-when-idle") || bounded,
  };
}
