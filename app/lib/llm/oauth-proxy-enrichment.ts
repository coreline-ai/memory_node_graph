import type { KnowledgeEdge } from "../../graph-data";
import { getOAuthAccessToken, getOAuthLlmConfig } from "./oauth-client";
import type { GraphEnrichmentInput, GraphEnrichmentProvider } from "./graph-enrichment-provider";

export class OAuthProxyGraphEnrichment implements GraphEnrichmentProvider {
  readonly name = "oauth-llm";

  async enrich(input: GraphEnrichmentInput): Promise<KnowledgeEdge[]> {
    const config = getOAuthLlmConfig();
    const token = await getOAuthAccessToken();
    const response = await fetch(`${config.upstreamBaseUrl}/${config.graphPath}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        task: "knowledge_graph_relation_enrichment",
        document: input.documentName,
        nodes: input.nodes.map(({ id, label, kind, domain, summary }) => ({ id, label, kind, domain, summary })),
        existingEdges: input.edges,
        output: "JSON array of {source,target,type,confidence,note}; only use supplied node ids",
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`OAuth LLM 관계 보강 실패 (${response.status})`);
    const payload = (await response.json()) as { edges?: unknown } | unknown[];
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.edges)
        ? payload.edges
        : [];
    const ids = new Set(input.nodes.map((node) => node.id));
    const allowedTypes = new Set([
      "documents", "plans", "contains", "supports", "extends",
      "requires", "uses", "mitigates", "risks", "contradicts",
    ]);
    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const row = candidate as Record<string, unknown>;
      const source = String(row.source ?? "");
      const target = String(row.target ?? "");
      const type = String(row.type ?? "supports");
      if (!ids.has(source) || !ids.has(target) || !allowedTypes.has(type)) return [];
      return [{
        source,
        target,
        type: type as KnowledgeEdge["type"],
        confidence: Math.max(0.35, Math.min(1, Number(row.confidence) || 0.65)),
        note: String(row.note ?? "OAuth LLM이 문서 근거로 제안한 관계"),
      }];
    });
  }
}
