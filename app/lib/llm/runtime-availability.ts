import { getCodexRuntimeStatus } from "./codex-runtime-service";

export const RUNTIME_ONLINE_WINDOW_MS = 45_000;

export async function getCodexRuntimeAvailability(now = Date.now()) {
  const runtime = await getCodexRuntimeStatus(now);
  return {
    status: runtime.available ? "online" as const : "offline" as const,
    onlineCount: runtime.available ? 1 : 0,
    lastSeenAt: runtime.lastSeenAt,
    runtime,
  };
}
