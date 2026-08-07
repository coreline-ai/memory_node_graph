import { getEnrichmentJobRepository } from "../storage/enrichment-job-repository";

export const CONNECTOR_ONLINE_WINDOW_MS = 45_000;

export async function getCodexConnectorAvailability(now = Date.now()) {
  const heartbeats = await (await getEnrichmentJobRepository()).listConnectorHeartbeats();
  const online = heartbeats.filter((heartbeat) => {
    const lastSeenAt = Date.parse(heartbeat.lastSeenAt);
    return heartbeat.status === "online"
      && Number.isFinite(lastSeenAt)
      && now - lastSeenAt <= CONNECTOR_ONLINE_WINDOW_MS;
  });
  return {
    status: online.length ? "online" as const : "offline" as const,
    onlineCount: online.length,
    lastSeenAt: heartbeats[0]?.lastSeenAt,
  };
}
