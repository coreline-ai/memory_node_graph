import { getEnrichmentJobRepository } from "../storage/enrichment-job-repository";
import { deriveCodexRuntimeStatus } from "./codex-runtime-status";

export async function getCodexRuntimeStatus(now = Date.now()) {
  const repository = await getEnrichmentJobRepository();
  return deriveCodexRuntimeStatus(await repository.listRuntimeStatuses(), now);
}
