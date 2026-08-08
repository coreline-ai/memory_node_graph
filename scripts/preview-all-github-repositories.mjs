import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PREVIEW_BATCH_SIZE = 10;
export const STAGE_CHUNK_MAX_FILES = 20;
export const REPOSITORY_APPLY_MAX_FILES = 500;
export const REPOSITORY_APPLY_MAX_BYTES = 8 * 1024 * 1024;

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function normalizeRepositoryIds(values) {
  if (!Array.isArray(values)) throw new Error("Discovery 선택 저장소 목록이 배열이 아닙니다.");
  const ids = values.map(String);
  if (ids.some((id) => !/^[1-9][0-9]*$/.test(id))) {
    throw new Error("Discovery 선택 저장소 ID 형식이 잘못되었습니다.");
  }
  const unique = [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== ids.length) throw new Error("Discovery 선택 저장소 ID가 중복되었습니다.");
  return unique;
}

export function splitRepositoryIds(values, batchSize = PREVIEW_BATCH_SIZE) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > PREVIEW_BATCH_SIZE) {
    throw new Error(`Preview batch 크기는 1~${PREVIEW_BATCH_SIZE}여야 합니다.`);
  }
  const ids = normalizeRepositoryIds(values);
  return Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, index) =>
    ids.slice(index * batchSize, (index + 1) * batchSize));
}

function skippedReasonCounts(repositories) {
  const counts = new Map();
  repositories.forEach((repository) => repository.skipped.forEach((item) => {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }));
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

export function aggregatePreviewJobs({
  discoveryJobId,
  repositoryIds,
  previewJobIds,
  jobs,
  generatedAt = new Date().toISOString(),
}) {
  const expectedIds = normalizeRepositoryIds(repositoryIds);
  const expectedSet = new Set(expectedIds);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const selectedJobs = previewJobIds.map((jobId) => {
    const job = jobById.get(jobId);
    if (!job) throw new Error(`Preview 작업 결과를 찾을 수 없습니다: ${jobId}`);
    if (job.kind !== "preview") throw new Error(`Preview가 아닌 작업이 포함되었습니다: ${jobId}`);
    if (job.status !== "completed" || !job.result?.preview) {
      throw new Error(`Preview 작업이 완료되지 않았습니다: ${jobId} (${job.status})`);
    }
    return job;
  });
  const repositories = selectedJobs
    .flatMap((job) => job.result.preview.repositories)
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const actualIds = repositories.map((repository) => repository.repositoryId);
  const uniqueActual = new Set(actualIds);
  if (
    actualIds.length !== expectedIds.length
    || uniqueActual.size !== actualIds.length
    || actualIds.some((id) => !expectedSet.has(id))
    || expectedIds.some((id) => !uniqueActual.has(id))
  ) throw new Error("전체 Preview 결과에 중복·누락·예상 밖 저장소가 있습니다.");

  const rows = repositories.map((repository) => {
    const files = Array.isArray(repository.files) ? repository.files : [];
    const skipped = Array.isArray(repository.skipped) ? repository.skipped : [];
    const bytes = files.reduce((sum, file) => sum + Number(file.size ?? 0), 0);
    const applyLimitReasons = [
      ...(files.length > REPOSITORY_APPLY_MAX_FILES ? [`files>${REPOSITORY_APPLY_MAX_FILES}`] : []),
      ...(bytes > REPOSITORY_APPLY_MAX_BYTES ? [`bytes>${REPOSITORY_APPLY_MAX_BYTES}`] : []),
    ];
    const stageRequired = files.length > STAGE_CHUNK_MAX_FILES;
    return {
      repositoryId: repository.repositoryId,
      repositoryName: repository.repositoryName,
      status: repository.status,
      defaultBranch: repository.defaultBranch,
      commitSha: repository.commitSha,
      treeStrategy: repository.treeStrategy,
      fileCount: files.length,
      readmeCount: files.filter((file) => file.role === "readme").length,
      devPlanCount: files.filter((file) => file.role === "dev-plan").length,
      bytes,
      skippedCount: skipped.length,
      skipped,
      blockedReason: repository.blockedReason,
      manifestDigest: repository.digest,
      applyLimitExceeded: applyLimitReasons.length > 0,
      applyLimitReasons,
      stageRequired,
    };
  });
  const totals = {
    discovered: expectedIds.length,
    previewed: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    empty: rows.filter((row) => row.status === "ready" && row.fileCount === 0).length,
    repositoriesWithDocuments: rows.filter((row) => row.fileCount > 0).length,
    applyEligibleReady: rows.filter((row) => row.status === "ready" && !row.applyLimitExceeded).length,
    applyLimitExceeded: rows.filter((row) => row.status === "ready" && row.applyLimitExceeded).length,
    stageRequired: rows.filter((row) => row.status === "ready" && row.stageRequired).length,
    files: rows.reduce((sum, row) => sum + row.fileCount, 0),
    readme: rows.reduce((sum, row) => sum + row.readmeCount, 0),
    devPlan: rows.reduce((sum, row) => sum + row.devPlanCount, 0),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    skipped: rows.reduce((sum, row) => sum + row.skippedCount, 0),
  };
  if (totals.ready + totals.blocked !== totals.previewed) {
    throw new Error("Preview ready·blocked 합계가 전체 저장소 수와 다릅니다.");
  }
  return {
    generatedAt,
    discoveryJobId,
    previewJobIds: [...previewJobIds],
    batchCount: previewJobIds.length,
    batchSize: PREVIEW_BATCH_SIZE,
    totals,
    skippedReasons: skippedReasonCounts(rows),
    repositories: rows,
  };
}

const number = new Intl.NumberFormat("ko-KR");

export function renderPreviewReport(receipt) {
  const lines = [
    "# GitHub 전체 저장소 Metadata Preview",
    "",
    `생성 시각: \`${receipt.generatedAt}\``,
    "",
    "이 보고서는 GitHub 원문을 다운로드하지 않고 README와 `dev-plan/**/*.md` manifest만 조회한 결과다.",
    "",
    "## 요약",
    "",
    "| 항목 | 수량 |",
    "|---|---:|",
    `| Discovery 선택 저장소 | ${number.format(receipt.totals.discovered)} |`,
    `| Preview 완료 저장소 | ${number.format(receipt.totals.previewed)} |`,
    `| Ready | ${number.format(receipt.totals.ready)} |`,
    `| Blocked | ${number.format(receipt.totals.blocked)} |`,
    `| 대상 문서가 없는 저장소 | ${number.format(receipt.totals.empty)} |`,
    `| 대상 문서가 있는 저장소 | ${number.format(receipt.totals.repositoriesWithDocuments)} |`,
    `| 현재 단일 Apply 가능 | ${number.format(receipt.totals.applyEligibleReady)} |`,
    `| 분할 stage 필요(20파일 초과) | ${number.format(receipt.totals.stageRequired)} |`,
    `| 저장소 Apply 안전 상한 초과 | ${number.format(receipt.totals.applyLimitExceeded)} |`,
    `| 전체 Markdown | ${number.format(receipt.totals.files)} |`,
    `| README | ${number.format(receipt.totals.readme)} |`,
    `| dev-plan | ${number.format(receipt.totals.devPlan)} |`,
    `| 전체 용량 | ${number.format(receipt.totals.bytes)} bytes |`,
    `| 생략 항목 | ${number.format(receipt.totals.skipped)} |`,
    "",
    "## 저장소별 결과",
    "",
    "| 저장소 | 상태 | README | dev-plan | 파일 | 용량(bytes) | 생략 |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...receipt.repositories.map((repository) =>
      `| ${repository.repositoryName} | ${repository.status}${repository.blockedReason ? ` · ${repository.blockedReason}` : ""}${repository.stageRequired ? " · staged" : ""}${repository.applyLimitExceeded ? ` · apply-limit(${repository.applyLimitReasons.join(",")})` : ""} | ${repository.readmeCount} | ${repository.devPlanCount} | ${repository.fileCount} | ${repository.bytes} | ${repository.skippedCount} |`),
    "",
    "## 현재 Apply 상한 초과 저장소",
    "",
    ...(receipt.repositories.some((repository) => repository.applyLimitExceeded)
      ? receipt.repositories.filter((repository) => repository.applyLimitExceeded).map((repository) =>
          `- \`${repository.repositoryName}\`: ${repository.fileCount}개 · ${number.format(repository.bytes)} bytes · ${repository.applyLimitReasons.join(", ")}`)
      : ["- 없음"]),
    "",
    "## 실행 경계",
    "",
    "- GitHub 원문 Blob은 다운로드하지 않았다.",
    "- 로컬 문서·엔티티·관계 그래프는 변경하지 않았다.",
    "- 실제 수집은 이 결과를 검토한 뒤 저장소별 단일 Apply로 진행한다.",
    "",
  ];
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = {
    baseUrl: process.env.ATLAS_RUNTIME_ORIGIN?.trim() || "http://localhost:3000",
    pollMs: 1_000,
    timeoutMs: 30 * 60 * 1_000,
    runId: `full-preview-${Date.now()}`,
    outputJson: "",
    outputMarkdown: "",
    reuseReceipt: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (value === "--poll-ms" && next) {
      options.pollMs = Number(next);
      index += 1;
    } else if (value === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (value === "--run-id" && next) {
      options.runId = next;
      index += 1;
    } else if (value === "--output-json" && next) {
      options.outputJson = next;
      index += 1;
    } else if (value === "--output-md" && next) {
      options.outputMarkdown = next;
      index += 1;
    } else if (value === "--reuse-receipt" && next) {
      options.reuseReceipt = next;
      index += 1;
    } else {
      throw new Error(`알 수 없거나 값이 없는 인자입니다: ${value}`);
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,59}$/.test(options.runId)) {
    throw new Error("run-id는 60자 이하의 안전한 식별자여야 합니다.");
  }
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 250) throw new Error("poll-ms가 잘못되었습니다.");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("timeout-ms가 잘못되었습니다.");
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  options.outputJson ||= `docs/github-full-preview-${date}.json`;
  options.outputMarkdown ||= `docs/github-full-preview-${date}.md`;
  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

async function jsonRequest(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${response.status} 응답이 JSON이 아닙니다.`);
  }
  if (!response.ok) throw new Error(String(payload.error ?? payload.message ?? `${response.status} 요청 실패`));
  return payload;
}

const latestDiscovery = (jobs) => [...jobs]
  .filter((job) => job.kind === "discovery" && job.status === "completed" && job.result?.discovery)
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function atomicWrite(path, content) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, absolute);
}

export async function runPreviewAll(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const initial = await jsonRequest(`${options.baseUrl}/api/github/source-jobs`);
  if (options.reuseReceipt) {
    const previous = JSON.parse(await readFile(resolve(options.reuseReceipt), "utf8"));
    const receipt = aggregatePreviewJobs({
      discoveryJobId: previous.discoveryJobId,
      repositoryIds: previous.repositories.map((repository) => repository.repositoryId),
      previewJobIds: previous.previewJobIds,
      jobs: initial.jobs ?? [],
    });
    await atomicWrite(options.outputJson, `${JSON.stringify(receipt, null, 2)}\n`);
    await atomicWrite(options.outputMarkdown, renderPreviewReport(receipt));
    console.info(`[full-preview] reused jobs=${receipt.previewJobIds.length} repositories=${receipt.totals.previewed}`);
    return receipt;
  }
  const discovery = latestDiscovery(initial.jobs ?? []);
  if (!discovery) throw new Error("완료된 GitHub Discovery 결과가 없습니다.");
  const repositoryIds = normalizeRepositoryIds(discovery.result.discovery.selection?.selectedRepositoryIds);
  if (!repositoryIds.length) throw new Error("Discovery에서 선택된 저장소가 없습니다.");
  const batches = splitRepositoryIds(repositoryIds);
  console.info(`[full-preview] discovery=${repositoryIds.length} batches=${batches.length}`);

  const previewJobIds = [];
  for (let index = 0; index < batches.length; index += 1) {
    const response = await jsonRequest(`${options.baseUrl}/api/github/source-jobs`, {
      method: "POST",
      body: JSON.stringify({
        kind: "preview",
        owner: "coreline-ai",
        selectedRepositoryIds: batches[index],
        requestNonce: `${options.runId}:batch:${String(index + 1).padStart(2, "0")}`,
      }),
    });
    previewJobIds.push(response.job.id);
    console.info(`[full-preview] queued batch=${index + 1}/${batches.length} repositories=${batches[index].length} job=${response.job.id}`);
  }

  const startedAt = Date.now();
  let currentJobs = initial.jobs ?? [];
  let previousSummary = "";
  while (Date.now() - startedAt < options.timeoutMs) {
    const snapshot = await jsonRequest(`${options.baseUrl}/api/github/source-jobs`);
    currentJobs = snapshot.jobs ?? [];
    const jobById = new Map(currentJobs.map((job) => [job.id, job]));
    const statuses = previewJobIds.map((jobId) => jobById.get(jobId)?.status ?? "missing");
    const summary = [...new Set(statuses)].sort().map((status) => `${status}:${statuses.filter((item) => item === status).length}`).join(" ");
    if (summary !== previousSummary) {
      console.info(`[full-preview] ${summary}`);
      previousSummary = summary;
    }
    if (statuses.every((status) => terminalStatuses.has(status))) break;
    await sleep(options.pollMs);
  }
  const jobById = new Map(currentJobs.map((job) => [job.id, job]));
  const unresolved = previewJobIds.filter((jobId) => !terminalStatuses.has(jobById.get(jobId)?.status));
  if (unresolved.length) throw new Error(`Preview 제한 시간 초과: ${unresolved.join(", ")}`);
  const failed = previewJobIds
    .map((jobId) => jobById.get(jobId))
    .filter((job) => job?.status !== "completed");
  if (failed.length) {
    throw new Error(`Preview 실패: ${failed.map((job) => `${job.id}(${job.status}:${job.errorCode ?? "unknown"})`).join(", ")}`);
  }

  const receipt = aggregatePreviewJobs({
    discoveryJobId: discovery.id,
    repositoryIds,
    previewJobIds,
    jobs: currentJobs,
  });
  await atomicWrite(options.outputJson, `${JSON.stringify(receipt, null, 2)}\n`);
  await atomicWrite(options.outputMarkdown, renderPreviewReport(receipt));
  console.info(`[full-preview] complete repositories=${receipt.totals.previewed} files=${receipt.totals.files} bytes=${receipt.totals.bytes}`);
  console.info(`[full-preview] json=${resolve(options.outputJson)}`);
  console.info(`[full-preview] report=${resolve(options.outputMarkdown)}`);
  return receipt;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runPreviewAll().catch((error) => {
    console.error(`[full-preview] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
