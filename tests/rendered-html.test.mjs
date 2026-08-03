import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.ATLAS_MEMORY_STORAGE = "true";
process.env.ATLAS_TEST_MODE = "true";

let workerPromise;

async function worker() {
  workerPromise ??= import(new URL("../dist/server/index.js", import.meta.url).href).then(
    (module) => module.default,
  );
  return workerPromise;
}

async function request(path, init) {
  const handler = await worker();
  return handler.fetch(
    new Request(`http://localhost${path}`, init),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the graph with grouped controls and the three graph views", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /AI Systems Atlas/);
  assert.match(html, /별자리/);
  assert.match(html, /성운/);
  assert.match(html, /궤도/);
  assert.match(html, /문서 관리/);
  assert.match(html, /class="control-status"/);
  assert.match(html, /현재 제어 상태:/);
  assert.match(html, /class="control-cluster view-cluster"/);
  assert.match(html, /class="control-cluster data-cluster"/);
  assert.match(html, /class="control-cluster stage-cluster"/);
  assert.match(html, /graph-controls-scroll-hint/);
  assert.match(html, /작은 화면에서는 가로로 스크롤/);
  assert.match(html, /그래프 데이터 선택/);
  assert.doesNotMatch(html, /LightRAG/);
});

test("server-renders Atlas Control Room", async () => {
  const response = await request("/dashboard");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /CONTROL ROOM/);
  assert.match(html, /문서 지식 관제실/);
  assert.match(html, /Markdown 추가/);
  assert.match(html, /DOCUMENT LIBRARY/);
  assert.match(html, /PIPELINE ACTIVITY/);
  assert.match(html, /Connector 오프라인/);
  assert.match(html, /AI 보강 작업/);
});

test("graph API uses the built-in snapshot before documents are added", async () => {
  const response = await request("/api/graph");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.meta.source, "demo");
  assert.equal(payload.meta.provider, "built-in");
  assert.equal(payload.nodes.length, 44);
  assert.equal(payload.edges.length, 74);
});

test("maximum-density showcase is deterministic and does not replace current graph data", async () => {
  const showcaseResponse = await request("/api/graph?showcase=max");
  assert.equal(showcaseResponse.status, 200);
  const showcase = await showcaseResponse.json();
  assert.equal(showcase.meta.provider, "performance-fixture");
  assert.equal(showcase.nodes.length, 500);
  assert.equal(showcase.edges.length, 2_000);
  assert.equal(showcase.nodes[0].id, "perf-node-0");

  const currentResponse = await request("/api/graph");
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  assert.equal(current.meta.provider, "built-in");
  assert.equal(current.nodes.length, 44);
  assert.equal(current.edges.length, 74);
});

test("write access can be separated from public reads behind an OAuth proxy", async () => {
  process.env.ATLAS_WRITE_ACCESS = "authenticated";
  try {
    const graph = await request("/api/graph");
    assert.equal(graph.status, 200);

    const blocked = await request("/api/documents", { method: "POST", body: new FormData() });
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).code, "ATLAS_AUTH_REQUIRED");

    const trusted = await request("/api/documents", {
      method: "POST",
      headers: { "oai-authenticated-user-id": "test-user" },
      body: new FormData(),
    });
    assert.equal(trusted.status, 400);
  } finally {
    process.env.ATLAS_WRITE_ACCESS = "public";
  }
});

test("Markdown upload rejects boundary and disguised-binary inputs", async () => {
  const cases = [
    {
      name: "wrong.txt",
      bytes: new TextEncoder().encode("# 확장자 오류"),
      pattern: /\.md.*\.mdx/,
    },
    {
      name: "image.md",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pattern: /바이너리/,
    },
    {
      name: "invalid-utf8.md",
      bytes: Uint8Array.from([0x23, 0x20, 0xc3, 0x28]),
      pattern: /UTF-8/,
    },
    {
      name: "empty.md",
      bytes: new Uint8Array(),
      pattern: /빈 문서/,
    },
  ];

  for (const fixture of cases) {
    const form = new FormData();
    form.append("files", new File([fixture.bytes], fixture.name, { type: "application/octet-stream" }));
    const response = await request("/api/documents", { method: "POST", body: form });
    assert.equal(response.status, 400, fixture.name);
    assert.match(JSON.stringify(await response.json()), fixture.pattern, fixture.name);
  }

  const bomForm = new FormData();
  bomForm.append(
    "files",
    new File(["\uFEFF# BOM 문서\r\n\r\n기능: 정규화"], "bom.md", { type: "text/markdown" }),
  );
  const accepted = await request("/api/documents", { method: "POST", body: bomForm });
  assert.equal(accepted.status, 201);
  const payload = await accepted.json();
  assert.equal(payload.snapshot.documents.length, 1);
  const documentId = payload.snapshot.documents[0].id;
  await request(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
});

test("document API validates, parses, deduplicates, and deletes Markdown", async () => {
  const empty = await request("/api/documents", { method: "POST", body: new FormData() });
  assert.equal(empty.status, 400);
  assert.match(JSON.stringify(await empty.json()), /Markdown/);

  const form = new FormData();
  form.append(
    "files",
    new File(
      ["# Atlas 테스트\n\n## 그래프\n\n기능: 세 가지 보기\n\n`GraphRenderer`는 [Three.js](https://threejs.org)를 사용합니다."],
      "atlas-test.md",
      { type: "text/markdown" },
    ),
  );
  const upload = await request("/api/documents", { method: "POST", body: form });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.snapshot.documents.length, 1);
  assert.ok(uploaded.snapshot.totals.nodes >= 5);
  assert.ok(uploaded.snapshot.totals.edges >= 4);

  const duplicateForm = new FormData();
  duplicateForm.append(
    "files",
    new File(
      ["# Atlas 테스트\n\n## 그래프\n\n기능: 세 가지 보기\n\n`GraphRenderer`는 [Three.js](https://threejs.org)를 사용합니다."],
      "atlas-test.md",
      { type: "text/markdown" },
    ),
  );
  const duplicate = await request("/api/documents", { method: "POST", body: duplicateForm });
  assert.equal(duplicate.status, 201);
  const duplicatePayload = await duplicate.json();
  assert.equal(duplicatePayload.results[0].unchanged, true);

  const graph = await request("/api/graph");
  const graphPayload = await graph.json();
  assert.equal(graphPayload.meta.source, "documents");
  assert.ok(graphPayload.nodes.some((node) => node.label === "세 가지 보기"));

  const documentId = uploaded.snapshot.documents[0].id;
  const removed = await request(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).snapshot.documents.length, 0);
});

test("shared entities survive deletion and failed replacement preserves the previous graph", async () => {
  const upload = async (name, source) => {
    const form = new FormData();
    form.append("files", new File([source], name, { type: "text/markdown" }));
    return request("/api/documents", { method: "POST", body: form });
  };

  const first = await upload("shared-a.md", "# 문서 A\n\n기능: 공유 지식\n\n## A 전용");
  const second = await upload("shared-b.md", "# 문서 B\n\n기능: 공유 지식\n\n## B 전용");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstPayload = await first.json();
  const secondPayload = await second.json();

  let graph = await (await request("/api/graph")).json();
  assert.equal(graph.nodes.filter((node) => node.label === "공유 지식").length, 1);

  await request(`/api/documents/${encodeURIComponent(firstPayload.results[0].document.id)}`, {
    method: "DELETE",
  });
  graph = await (await request("/api/graph")).json();
  assert.ok(graph.nodes.some((node) => node.label === "공유 지식"));
  assert.ok(graph.nodes.some((node) => node.label === "B 전용"));

  const resilient = await upload("resilient.md", "# 안정 버전\n\n기능: 이전 그래프 보존");
  assert.equal(resilient.status, 201);
  const resilientPayload = await resilient.json();
  process.env.ATLAS_TEST_FAIL_SAVE = "resilient.md";
  try {
    const failed = await upload("resilient.md", "# 실패 버전\n\n기능: 저장되면 안 됨");
    assert.equal(failed.status, 400);
    assert.match(JSON.stringify(await failed.json()), /테스트용 저장 실패/);
  } finally {
    delete process.env.ATLAS_TEST_FAIL_SAVE;
  }
  graph = await (await request("/api/graph")).json();
  assert.ok(graph.nodes.some((node) => node.label === "안정 버전"));
  assert.ok(!graph.nodes.some((node) => node.label === "실패 버전"));

  for (const id of [
    secondPayload.results[0].document.id,
    resilientPayload.results[0].document.id,
  ]) {
    await request(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  assert.equal((await (await request("/api/documents")).json()).totals.documents, 0);
});

test("Connector API authenticates, validates evidence, and merges one idempotent result", async () => {
  process.env.ATLAS_CONNECTOR_TOKEN = "connector-test-token";
  const connectorHeaders = {
    authorization: "Bearer connector-test-token",
    "content-type": "application/json",
    "x-atlas-connector-id": "connector-test-1",
  };
  const form = new FormData();
  form.append(
    "files",
    new File(
      ["# Connector API\n\n## 검색\n\n개념: 근거 기반 검색\n\n## 그래프\n\n개념: 관계 지식"],
      "connector-api.md",
      { type: "text/markdown" },
    ),
  );

  try {
    const upload = await request("/api/documents", { method: "POST", body: form });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    const documentId = uploaded.results[0].document.id;
    assert.equal(uploaded.results[0].enrichment.created, true);

    const unauthenticated = await request("/api/enrichment-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atlas-connector-id": "connector-test-1" },
      body: "{}",
    });
    assert.equal(unauthenticated.status, 401);

    const claim = await request("/api/enrichment-jobs/claim", {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify({ leaseDurationMs: 60_000 }),
    });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()).job;
    assert.equal(claimed.documentId, documentId);
    assert.equal(claimed.status, "leased");

    const started = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/start`, {
      method: "POST",
      headers: connectorHeaders,
      body: "{}",
    });
    assert.equal(started.status, 200);

    const mismatched = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/result`, {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify({
        jobId: "wrong-job",
        idempotencyKey: claimed.idempotencyKey,
        documentHash: claimed.documentHash,
        provider: claimed.provider,
        providerVersion: claimed.providerVersion,
        promptVersion: claimed.promptVersion,
        status: "completed",
        relations: [],
        warnings: [],
      }),
    });
    assert.equal(mismatched.status, 400);

    const existing = new Set(claimed.input.existingRelations.map(
      (edge) => `${edge.source}|${edge.target}|${edge.type}`,
    ));
    let pair;
    for (const source of claimed.input.nodes) {
      for (const target of claimed.input.nodes) {
        if (source.id !== target.id && !existing.has(`${source.id}|${target.id}|supports`)) {
          pair = [source.id, target.id];
          break;
        }
      }
      if (pair) break;
    }
    assert.ok(pair);
    const evidenceBlock = claimed.input.evidenceBlocks[0];
    const result = {
      jobId: claimed.id,
      idempotencyKey: claimed.idempotencyKey,
      documentHash: claimed.documentHash,
      provider: claimed.provider,
      providerVersion: claimed.providerVersion,
      promptVersion: claimed.promptVersion,
      status: "completed",
      relations: [
        {
          source: pair[0],
          target: pair[1],
          type: "supports",
          confidence: 0.88,
          note: "문서 근거가 두 지식 노드의 관계를 지지합니다.",
          evidence: [{ blockId: evidenceBlock.id, explanation: "명시적 문서 근거" }],
        },
        {
          source: "unknown-node",
          target: pair[1],
          type: "supports",
          confidence: 0.5,
          note: "존재하지 않는 노드는 거부되어야 합니다.",
          evidence: [{ blockId: evidenceBlock.id, explanation: "잘못된 후보" }],
        },
        {
          source: pair[1],
          target: pair[0],
          type: "not-allowed",
          confidence: 0.5,
          note: "허용되지 않는 유형은 거부되어야 합니다.",
          evidence: [{ blockId: "unknown-block", explanation: "잘못된 근거" }],
        },
      ],
      warnings: [],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
    };
    const submitted = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/result`, {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify(result),
    });
    assert.equal(submitted.status, 200);
    const submittedJob = (await submitted.json()).job;
    assert.equal(submittedJob.status, "warning");
    assert.equal(submittedJob.result.relations.length, 1);
    assert.ok(submittedJob.result.warnings.length >= 2);

    const duplicate = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/result`, {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify(result),
    });
    assert.equal(duplicate.status, 409);

    const graph = await (await request("/api/graph")).json();
    assert.equal(
      graph.edges.filter((edge) => edge.source === pair[0] && edge.target === pair[1] && edge.type === "supports").length,
      1,
    );

    const heartbeat = await request("/api/enrichment-jobs/heartbeat", {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify({ status: "online", version: "atlas-connector-test", currentJobId: claimed.id }),
    });
    assert.equal(heartbeat.status, 200);
    let dashboard = await (await request("/api/documents")).json();
    assert.equal(dashboard.connector.status, "online");
    assert.equal(dashboard.enrichmentJobs[0].status, "warning");

    const retried = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/retry`, {
      method: "POST",
    });
    assert.equal(retried.status, 200);
    const retriedPayload = await retried.json();
    assert.equal(retriedPayload.job.status, "queued");
    assert.equal(retriedPayload.job.manualRetryCount, 1);
    assert.equal(retriedPayload.snapshot.enrichmentJobs[0].status, "queued");

    const duplicateRetry = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/retry`, {
      method: "POST",
    });
    assert.equal(duplicateRetry.status, 400);
    const graphAfterRetry = await (await request("/api/graph")).json();
    assert.equal(
      graphAfterRetry.edges.filter((edge) => edge.source === pair[0] && edge.target === pair[1] && edge.type === "supports").length,
      0,
    );

    const cancelled = await request(`/api/enrichment-jobs/${encodeURIComponent(claimed.id)}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).snapshot.enrichmentJobs[0].status, "cancelled");

    await request("/api/enrichment-jobs/heartbeat", {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify({ status: "offline", version: "atlas-connector-test" }),
    });
    dashboard = await (await request("/api/documents")).json();
    assert.equal(dashboard.connector.status, "offline");

    process.env.ATLAS_WRITE_ACCESS = "authenticated";
    const forbiddenDocumentDelete = await request(`/api/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers: connectorHeaders,
    });
    assert.equal(forbiddenDocumentDelete.status, 401);
    process.env.ATLAS_WRITE_ACCESS = "public";
    await request(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  } finally {
    process.env.ATLAS_WRITE_ACCESS = "public";
    delete process.env.ATLAS_CONNECTOR_TOKEN;
  }
});

test("implementation has modular layouts and no LightRAG runtime", async () => {
  const [graph, layouts, packageJson] = await Promise.all([
    readFile(new URL("../app/knowledge-graph.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/graph/layouts.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(graph, /GraphViewMode/);
  assert.match(graph, /normal.*bright.*supernova/s);
  assert.match(graph, /new URL\("\/api\/graph"/);
  assert.match(layouts, /constellationLayout/);
  assert.match(layouts, /nebulaLayout/);
  assert.match(layouts, /orbitLayout/);
  assert.doesNotMatch(`${graph}\n${packageJson}`, /LIGHTRAG_API_KEY|LightRagAdapter/);
});
