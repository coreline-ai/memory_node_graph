import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const terminalJobStatuses = new Set(["completed", "failed", "cancelled"]);
const terminalRepositoryStatuses = new Set(["completed", "empty", "blocked"]);
const retryFieldByStage = Object.freeze({
  preview: "previewManualRetriesUsed",
  apply: "applyManualRetriesUsed",
});

const timestamp = () => new Date().toISOString();
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function atomicWrite(path, content) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, absolute);
}

function safeRunId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(value)) {
    throw new Error("run-id는 40자 이하의 안전한 식별자여야 합니다.");
  }
  return value;
}

function parseArguments(argv) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const options = {
    baseUrl: process.env.ATLAS_RUNTIME_ORIGIN?.trim() || "http://localhost:3000",
    sourceReceipt: "docs/github-full-preview-20260805.json",
    checkpoint: `docs/github-full-collection-${date}.checkpoint.json`,
    outputJson: `docs/github-full-collection-${date}.json`,
    outputMarkdown: `docs/github-full-collection-${date}.md`,
    runId: `collect-${date}`,
    pollMs: 1_000,
    timeoutMs: 15 * 60 * 1_000,
    manualRetries: 1,
    retryFailed: false,
    maximumRepositories: Number.POSITIVE_INFINITY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--base-url" && next) options.baseUrl = next;
    else if (value === "--source-receipt" && next) options.sourceReceipt = next;
    else if (value === "--checkpoint" && next) options.checkpoint = next;
    else if (value === "--output-json" && next) options.outputJson = next;
    else if (value === "--output-md" && next) options.outputMarkdown = next;
    else if (value === "--run-id" && next) options.runId = next;
    else if (value === "--poll-ms" && next) options.pollMs = Number(next);
    else if (value === "--timeout-ms" && next) options.timeoutMs = Number(next);
    else if (value === "--manual-retries" && next) options.manualRetries = Number(next);
    else if (value === "--max-repositories" && next) options.maximumRepositories = Number(next);
    else if (value === "--retry-failed") {
      options.retryFailed = true;
      continue;
    } else throw new Error(`알 수 없거나 값이 없는 인자입니다: ${value}`);
    index += 1;
  }
  options.runId = safeRunId(options.runId);
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 250) throw new Error("poll-ms가 잘못되었습니다.");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("timeout-ms가 잘못되었습니다.");
  if (!Number.isSafeInteger(options.manualRetries) || options.manualRetries < 0 || options.manualRetries > 2) {
    throw new Error("manual-retries는 0~2여야 합니다.");
  }
  if (
    options.maximumRepositories !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(options.maximumRepositories) || options.maximumRepositories < 1)
  ) throw new Error("max-repositories는 1 이상의 정수여야 합니다.");
  return options;
}

function repositoriesFromPreviewReceipt(receipt) {
  if (!objectValue(receipt) || !Array.isArray(receipt.repositories)) {
    throw new Error("전체 Preview 영수증 형식이 잘못되었습니다.");
  }
  const repositories = receipt.repositories.map((repository) => {
    const object = objectValue(repository);
    const repositoryId = String(object?.repositoryId ?? "");
    const repositoryName = String(object?.repositoryName ?? "");
    const expectedFileCount = Number(object?.fileCount);
    const expectedBytes = Number(object?.bytes);
    if (
      !/^[1-9][0-9]*$/.test(repositoryId)
      || !/^[a-zA-Z0-9._-]{1,100}$/.test(repositoryName)
      || !Number.isSafeInteger(expectedFileCount)
      || expectedFileCount < 0
      || !Number.isSafeInteger(expectedBytes)
      || expectedBytes < 0
    ) throw new Error("전체 Preview 저장소 항목 형식이 잘못되었습니다.");
    return { repositoryId, repositoryName, expectedFileCount, expectedBytes };
  }).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length) {
    throw new Error("전체 Preview 영수증에 중복 저장소가 있습니다.");
  }
  if (Number(receipt.totals?.previewed) !== repositories.length) {
    throw new Error("전체 Preview 영수증 저장소 합계가 일치하지 않습니다.");
  }
  return repositories;
}

export function createCollectionCheckpoint(receipt, options = {}) {
  const repositories = repositoriesFromPreviewReceipt(receipt);
  const createdAt = options.createdAt ?? timestamp();
  return {
    version: 1,
    runId: safeRunId(options.runId ?? "collection"),
    sourceReceipt: String(options.sourceReceipt ?? ""),
    sourceDiscoveryJobId: String(receipt.discoveryJobId ?? ""),
    createdAt,
    updatedAt: createdAt,
    repositories: repositories.map((repository) => ({
      ...repository,
      status: "pending",
      manualRetriesUsed: 0,
      previewCycle: 0,
      applyCycle: 0,
      previewManualRetriesUsed: 0,
      applyManualRetriesUsed: 0,
    })),
  };
}

function assertCompatibleCheckpoint(checkpoint, receipt, runId) {
  if (!objectValue(checkpoint) || checkpoint.version !== 1 || checkpoint.runId !== runId) {
    throw new Error("기존 전체 수집 checkpoint의 버전 또는 run-id가 다릅니다.");
  }
  const expected = repositoriesFromPreviewReceipt(receipt).map((repository) => repository.repositoryId);
  const actual = Array.isArray(checkpoint.repositories)
    ? checkpoint.repositories.map((repository) => String(repository.repositoryId))
    : [];
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("기존 전체 수집 checkpoint의 저장소 집합이 Preview 영수증과 다릅니다.");
  }
  return checkpoint;
}

export function summarizeCollectionCheckpoint(checkpoint) {
  const repositories = Array.isArray(checkpoint.repositories) ? checkpoint.repositories : [];
  const byStatus = (status) => repositories.filter((repository) => repository.status === status).length;
  const completed = repositories.filter((repository) => repository.status === "completed");
  return {
    repositories: repositories.length,
    completed: completed.length,
    empty: byStatus("empty"),
    blocked: byStatus("blocked"),
    failed: byStatus("failed"),
    pending: repositories.filter((repository) =>
      !terminalRepositoryStatuses.has(repository.status) && repository.status !== "failed").length,
    documents: completed.reduce((sum, repository) => sum + Number(repository.receipt?.fileCount ?? 0), 0),
    created: completed.reduce((sum, repository) => sum + Number(repository.receipt?.createdCount ?? 0), 0),
    updated: completed.reduce((sum, repository) => sum + Number(repository.receipt?.updatedCount ?? 0), 0),
    unchanged: completed.reduce((sum, repository) => sum + Number(repository.receipt?.unchangedCount ?? 0), 0),
    deleted: completed.reduce((sum, repository) => sum + Number(repository.receipt?.deletedCount ?? 0), 0),
    nodes: completed.reduce((sum, repository) => sum + Number(repository.receipt?.nodeCount ?? 0), 0),
    edges: completed.reduce((sum, repository) => sum + Number(repository.receipt?.edgeCount ?? 0), 0),
  };
}

const number = new Intl.NumberFormat("ko-KR");

export function renderCollectionReport(checkpoint) {
  const totals = summarizeCollectionCheckpoint(checkpoint);
  const lines = [
    "# GitHub Markdown 전체 수집 영수증",
    "",
    `Run ID: \`${checkpoint.runId}\``,
    "",
    `업데이트 시각: \`${checkpoint.updatedAt}\``,
    "",
    "## 요약",
    "",
    "| 항목 | 수량 |",
    "|---|---:|",
    `| 전체 저장소 | ${number.format(totals.repositories)} |`,
    `| 수집 완료 | ${number.format(totals.completed)} |`,
    `| 빈 저장소 | ${number.format(totals.empty)} |`,
    `| 차단 | ${number.format(totals.blocked)} |`,
    `| 실패 | ${number.format(totals.failed)} |`,
    `| 미완료 | ${number.format(totals.pending)} |`,
    `| 저장 문서 | ${number.format(totals.documents)} |`,
    `| 생성 | ${number.format(totals.created)} |`,
    `| 갱신 | ${number.format(totals.updated)} |`,
    `| 재사용 | ${number.format(totals.unchanged)} |`,
    `| 삭제 | ${number.format(totals.deleted)} |`,
    `| 노드 | ${number.format(totals.nodes)} |`,
    `| 관계 | ${number.format(totals.edges)} |`,
    "",
    "## 저장소별 결과",
    "",
    "| 저장소 | 상태 | Preview | Apply | 문서 | 노드 | 관계 | 오류 |",
    "|---|---|---|---|---:|---:|---:|---|",
    ...checkpoint.repositories.map((repository) =>
      `| ${repository.repositoryName} | ${repository.status} | ${repository.previewJobId ?? "-"} | ${repository.applyJobId ?? "-"} | ${repository.receipt?.fileCount ?? (repository.status === "empty" ? 0 : "-")} | ${repository.receipt?.nodeCount ?? "-"} | ${repository.receipt?.edgeCount ?? "-"} | ${repository.errorCode ?? repository.errorMessage ?? "-"} |`),
    "",
  ];
  return lines.join("\n");
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
  if (!response.ok) {
    const error = new Error(String(payload.error ?? payload.message ?? `${response.status} 요청 실패`));
    error.code = String(payload.code ?? "http_error");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function persistCheckpoint(checkpoint, options, final = false) {
  checkpoint.updatedAt = timestamp();
  await atomicWrite(options.checkpoint, `${JSON.stringify(checkpoint, null, 2)}\n`);
  if (final) {
    await atomicWrite(options.outputJson, `${JSON.stringify({
      ...checkpoint,
      totals: summarizeCollectionCheckpoint(checkpoint),
    }, null, 2)}\n`);
    await atomicWrite(options.outputMarkdown, renderCollectionReport(checkpoint));
  }
}

function stageCycle(repository, stage) {
  const value = Number(repository[`${stage}Cycle`] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function collectionRequestNonce(runId, repositoryId, stage, cycle = 0) {
  if (!retryFieldByStage[stage]) throw new Error(`지원하지 않는 수집 단계입니다: ${stage}`);
  const base = `${safeRunId(runId)}:${repositoryId}:${stage}`;
  return cycle > 0 ? `${base}:${cycle}` : base;
}

function stageRetriesUsed(repository, stage) {
  const field = retryFieldByStage[stage];
  const stageValue = Number(repository[field] ?? 0);
  const legacyValue = Number(repository.manualRetriesUsed ?? 0);
  if (Number.isSafeInteger(stageValue) && stageValue > 0) return stageValue;
  // Version 1 checkpoints initially used one shared counter. Preserve it only
  // for the stage that was active when the checkpoint was written.
  if (
    Number.isSafeInteger(legacyValue)
    && legacyValue > 0
    && ((stage === "apply" && repository.applyJobId) || (stage === "preview" && !repository.applyJobId))
  ) return legacyValue;
  return 0;
}

function setStageRetriesUsed(repository, stage, value) {
  repository[retryFieldByStage[stage]] = value;
  repository.manualRetriesUsed = value;
}

function prepareReplacementJob(repository, stage) {
  const cycleField = `${stage}Cycle`;
  const jobField = `${stage}JobId`;
  repository[cycleField] = stageCycle(repository, stage) + 1;
  repository[jobField] = undefined;
  setStageRetriesUsed(repository, stage, 0);
}

async function waitForJob(jobId, stage, options, checkpoint, repository) {
  const startedAt = Date.now();
  let previousStatus = "";
  while (Date.now() - startedAt < options.timeoutMs) {
    const payload = await jsonRequest(
      `${options.baseUrl}/api/github/source-jobs/${encodeURIComponent(jobId)}`,
    );
    const job = payload.job;
    if (!job) throw new Error(`작업 조회 결과가 없습니다: ${jobId}`);
    if (job.status !== previousStatus) {
      console.info(`[full-collection] repository=${repository.repositoryName} job=${job.kind} status=${job.status}`);
      previousStatus = job.status;
    }
    const retriesUsed = Math.max(
      stageRetriesUsed(repository, stage),
      Number.isSafeInteger(Number(job.manualRetryCount)) ? Number(job.manualRetryCount) : 0,
    );
    if (retriesUsed !== stageRetriesUsed(repository, stage)) {
      setStageRetriesUsed(repository, stage, retriesUsed);
      await persistCheckpoint(checkpoint, options);
    }
    if (job.status === "failed" && retriesUsed < options.manualRetries) {
      setStageRetriesUsed(repository, stage, retriesUsed + 1);
      await persistCheckpoint(checkpoint, options);
      await jsonRequest(`${options.baseUrl}/api/github/source-jobs/${encodeURIComponent(jobId)}/retry`, {
        method: "POST",
        body: "{}",
      });
      previousStatus = "";
      continue;
    }
    if (terminalJobStatuses.has(job.status)) return job;
    await sleep(options.pollMs);
  }
  throw new Error(`작업 제한 시간 초과: ${jobId}`);
}

function failRepository(repository, stage, error) {
  repository.status = "failed";
  repository.failureStage = stage;
  repository.errorCode = String(error?.code ?? "unknown");
  repository.errorMessage = error instanceof Error ? error.message.slice(0, 500) : "알 수 없는 오류";
  repository.completedAt = timestamp();
}

async function processRepository(repository, checkpoint, options) {
  if (terminalRepositoryStatuses.has(repository.status)) return;
  if (repository.status === "failed" && !options.retryFailed) return;
  if (repository.status === "failed") {
    repository.status = repository.failureStage === "applying" && repository.applyJobId
      ? "applying"
      : "previewing";
    repository.errorCode = undefined;
    repository.errorMessage = undefined;
    repository.failureStage = undefined;
  }
  repository.startedAt ??= timestamp();
  try {
    repository.status = "previewing";
    let previewJob;
    for (let replacement = 0; replacement <= 1; replacement += 1) {
      if (!repository.previewJobId) {
        const queued = await jsonRequest(`${options.baseUrl}/api/github/source-jobs`, {
          method: "POST",
          body: JSON.stringify({
            kind: "preview",
            owner: "coreline-ai",
            selectedRepositoryIds: [repository.repositoryId],
            requestNonce: collectionRequestNonce(
              options.runId,
              repository.repositoryId,
              "preview",
              stageCycle(repository, "preview"),
            ),
          }),
        });
        repository.previewJobId = queued.job.id;
        await persistCheckpoint(checkpoint, options);
      }
      previewJob = await waitForJob(
        repository.previewJobId,
        "preview",
        options,
        checkpoint,
        repository,
      );
      if (previewJob.status === "completed" || !options.retryFailed || replacement === 1) break;
      console.warn(
        `[full-collection] replacement repository=${repository.repositoryName}`
        + ` stage=preview previous_job=${repository.previewJobId}`,
      );
      prepareReplacementJob(repository, "preview");
      repository.applyJobId = undefined;
      repository.applyCycle = 0;
      setStageRetriesUsed(repository, "apply", 0);
      await persistCheckpoint(checkpoint, options);
    }
    if (previewJob.status !== "completed" || !previewJob.result?.preview) {
      const error = new Error(previewJob.errorMessage ?? "단일 저장소 Preview가 실패했습니다.");
      error.code = previewJob.errorCode ?? previewJob.status;
      throw error;
    }
    const preview = previewJob.result.preview;
    const manifest = preview.repositories?.[0];
    if (
      preview.selectedRepositoryIds?.length !== 1
      || preview.selectedRepositoryIds[0] !== repository.repositoryId
      || !manifest
      || manifest.repositoryId !== repository.repositoryId
    ) throw new Error("단일 저장소 Preview 결과가 수집 대상과 다릅니다.");
    repository.previewManifestDigest = preview.manifestDigest;
    repository.actualFileCount = manifest.files?.length ?? 0;
    repository.actualBytes = (manifest.files ?? []).reduce((sum, file) => sum + Number(file.size ?? 0), 0);
    if (manifest.status === "blocked") {
      repository.status = "blocked";
      repository.blockedReason = manifest.blockedReason ?? "blocked";
      repository.completedAt = timestamp();
      await persistCheckpoint(checkpoint, options);
      return;
    }
    if (!repository.actualFileCount) {
      repository.status = "empty";
      repository.completedAt = timestamp();
      await persistCheckpoint(checkpoint, options);
      return;
    }

    repository.status = "applying";
    let applyJob;
    for (let replacement = 0; replacement <= 1; replacement += 1) {
      if (!repository.applyJobId) {
        const queued = await jsonRequest(`${options.baseUrl}/api/github/source-jobs`, {
          method: "POST",
          body: JSON.stringify({
            kind: "apply",
            owner: "coreline-ai",
            selectedRepositoryIds: [repository.repositoryId],
            manifestDigest: preview.manifestDigest,
            requestNonce: collectionRequestNonce(
              options.runId,
              repository.repositoryId,
              "apply",
              stageCycle(repository, "apply"),
            ),
          }),
        });
        repository.applyJobId = queued.job.id;
        await persistCheckpoint(checkpoint, options);
      }
      applyJob = await waitForJob(
        repository.applyJobId,
        "apply",
        options,
        checkpoint,
        repository,
      );
      if (applyJob.status === "completed" || !options.retryFailed || replacement === 1) break;
      console.warn(
        `[full-collection] replacement repository=${repository.repositoryName}`
        + ` stage=apply previous_job=${repository.applyJobId}`,
      );
      prepareReplacementJob(repository, "apply");
      await persistCheckpoint(checkpoint, options);
    }
    if (applyJob.status !== "completed" || !applyJob.result?.apply) {
      const error = new Error(applyJob.errorMessage ?? "단일 저장소 Apply가 실패했습니다.");
      error.code = applyJob.errorCode ?? applyJob.status;
      throw error;
    }
    if (
      applyJob.result.apply.repositoryId !== repository.repositoryId
      || applyJob.result.apply.manifestDigest !== preview.manifestDigest
    ) throw new Error("단일 저장소 Apply 영수증이 Preview와 다릅니다.");
    repository.status = "completed";
    repository.receipt = applyJob.result.apply;
    repository.completedAt = timestamp();
    await persistCheckpoint(checkpoint, options);
  } catch (error) {
    failRepository(repository, repository.status, error);
    await persistCheckpoint(checkpoint, options);
    console.warn(`[full-collection] failed repository=${repository.repositoryName} stage=${repository.failureStage} message=${repository.errorMessage}`);
  }
}

export async function runCollection(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const receipt = JSON.parse(await readFile(resolve(options.sourceReceipt), "utf8"));
  let checkpoint;
  try {
    checkpoint = assertCompatibleCheckpoint(
      JSON.parse(await readFile(resolve(options.checkpoint), "utf8")),
      receipt,
      options.runId,
    );
    console.info(`[full-collection] resume checkpoint=${options.checkpoint}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    checkpoint = createCollectionCheckpoint(receipt, {
      runId: options.runId,
      sourceReceipt: options.sourceReceipt,
    });
    await persistCheckpoint(checkpoint, options);
  }

  let processed = 0;
  for (const repository of checkpoint.repositories) {
    if (processed >= options.maximumRepositories) break;
    if (terminalRepositoryStatuses.has(repository.status)) continue;
    if (repository.status === "failed" && !options.retryFailed) continue;
    processed += 1;
    console.info(
      `[full-collection] start ${processed}/${Math.min(options.maximumRepositories, checkpoint.repositories.length)}`
      + ` repository=${repository.repositoryName} expected_files=${repository.expectedFileCount}`,
    );
    await processRepository(repository, checkpoint, options);
    const totals = summarizeCollectionCheckpoint(checkpoint);
    console.info(
      `[full-collection] progress completed=${totals.completed} empty=${totals.empty}`
      + ` blocked=${totals.blocked} failed=${totals.failed} pending=${totals.pending}`,
    );
  }
  await persistCheckpoint(checkpoint, options, true);
  const totals = summarizeCollectionCheckpoint(checkpoint);
  console.info(`[full-collection] done ${JSON.stringify(totals)}`);
  return checkpoint;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCollection().catch((error) => {
    console.error(`[full-collection] fatal message=${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  });
}
