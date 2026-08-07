"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  DashboardEnrichmentJob,
  DashboardSnapshot,
  DocumentRecord,
} from "../lib/graph/model";
import type { GitHubRepositoryDescriptor } from "../lib/github/discovery-contracts";
import type {
  GitHubConnectorCapabilityRecord,
  GitHubSourceJobRecord,
} from "../lib/github/source-job-contracts";
import type {
  GitHubRepositorySyncStatus,
  GitHubRepositorySyncSummary,
} from "../lib/github/dashboard-projection";
import type { GitHubDashboardDryRun } from "../lib/github/dashboard-dry-run";
import { resolveGitHubCapabilityGuidance } from "../lib/github/capability-guidance";
import {
  countDashboardDocumentsBySource,
  filterDashboardDocumentsBySource,
  type DashboardDocumentSourceFilter,
} from "../lib/dashboard/document-source-filter";

type GitHubDashboardState = {
  jobs: GitHubSourceJobRecord[];
  capabilities: GitHubConnectorCapabilityRecord[];
  repositorySync: GitHubRepositorySyncSummary[];
  repositoryDryRun: GitHubDashboardDryRun | null;
};

type RepositoryFilter = "all" | "recommended" | "selected" | "public" | "private" | "warning";

type ReprocessPreview = {
  documents: Array<{
    documentId: string;
    fileName: string;
    repositoryName?: string;
    relativePath?: string;
    parserVersion: string;
    blockCount: number;
  }>;
  totals: {
    documents: number;
    repositories: number;
    blocks: number;
    chunks: number;
  };
  batchLimit: number;
};

const documentSourceFilterLabels: Record<DashboardDocumentSourceFilter, string> = {
  all: "전체",
  manual: "수동 업로드",
  github: "GitHub 동기화",
};

const emptyGitHubState: GitHubDashboardState = {
  jobs: [],
  capabilities: [],
  repositorySync: [],
  repositoryDryRun: null,
};

const emptySnapshot: DashboardSnapshot = {
  documents: [],
  jobs: [],
  enrichmentJobs: [],
  connector: { status: "offline", onlineCount: 0, queuedJobs: 0, activeJobs: 0 },
  totals: {
    documents: 0,
    nodes: 0,
    edges: 0,
    processing: 0,
    failed: 0,
    enrichmentQueued: 0,
    enrichmentActive: 0,
    enrichmentWarnings: 0,
  },
  storage: "memory",
};

const enrichmentLabels: Record<DashboardEnrichmentJob["status"], string> = {
  queued: "보강 대기",
  leased: "작업 연결 중",
  running: "Codex 분석 중",
  completed: "보강 완료",
  warning: "보강 경고",
  failed: "보강 실패",
  stale: "이전 결과",
  cancelled: "보강 취소됨",
};

const activeEnrichmentStatuses = new Set<DashboardEnrichmentJob["status"]>([
  "queued",
  "leased",
  "running",
]);

const statusLabels: Record<DocumentRecord["status"], string> = {
  queued: "처리 대기",
  validating: "파일 확인 중",
  parsing: "문서 구조 분석 중",
  unchanged: "변경 없음",
  completed: "그래프 반영 완료",
  failed: "처리하지 못함",
};

const number = new Intl.NumberFormat("ko-KR");
const date = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const connectorStopReasonLabels: Record<NonNullable<DashboardSnapshot["connector"]["stopReason"]>, string> = {
  dry_run: "DRY RUN",
  job_limit: "JOB LIMIT",
  runtime_limit: "TIME LIMIT",
  idle: "QUEUE EMPTY",
  once: "ONE JOB",
  signal: "STOPPED",
  fatal: "ERROR",
};

const runtimeLabel = (milliseconds?: number) => {
  if (!milliseconds) return "시간 제한 없음";
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1_000)}초`;
  return `${Math.ceil(milliseconds / 60_000)}분`;
};

const githubCapabilityLabels: Record<GitHubConnectorCapabilityRecord["status"], string> = {
  online: "GH ONLINE",
  login_required: "LOGIN REQUIRED",
  forbidden: "ACCESS DENIED",
  rate_limited: "RATE LIMITED",
  offline: "OFFLINE",
};

const activeGitHubStatuses = new Set<GitHubSourceJobRecord["status"]>(["queued", "leased", "running"]);
const githubPreviewMaxRepositories = 10;
const repositorySyncLabels: Record<GitHubRepositorySyncStatus, string> = {
  not_synced: "미동기화",
  syncing: "동기화 중",
  synced: "동기화 완료",
  failed: "동기화 실패",
  cancelled: "취소됨",
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `요청 실패 (${response.status})`);
  return payload;
}

export default function DashboardClient() {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [githubState, setGitHubState] = useState(emptyGitHubState);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [pendingJobAction, setPendingJobAction] = useState<string>("");
  const [documentSourceFilter, setDocumentSourceFilter] = useState<DashboardDocumentSourceFilter>("all");
  const [repositoryFilter, setRepositoryFilter] = useState<RepositoryFilter>("all");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>([]);
  const [startingDiscovery, setStartingDiscovery] = useState(false);
  const [startingPreview, setStartingPreview] = useState(false);
  const [startingApply, setStartingApply] = useState(false);
  const [pendingGitHubRetry, setPendingGitHubRetry] = useState("");
  const [reprocessPreview, setReprocessPreview] = useState<ReprocessPreview | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState({ completed: 0, failed: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionHydrationRef = useRef("");

  const load = useCallback(async () => {
    try {
      const [nextSnapshot, nextGitHubState] = await Promise.all([
        jsonRequest<DashboardSnapshot>("/api/documents", { cache: "no-store" }),
        jsonRequest<GitHubDashboardState>("/api/github/source-jobs", { cache: "no-store" }),
      ]);
      setSnapshot(nextSnapshot);
      setGitHubState(nextGitHubState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "문서 상태를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !uploading) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, uploading]);

  const selectedSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  const enrichmentByDocument = useMemo(() => {
    const latest = new Map<string, DashboardEnrichmentJob>();
    snapshot.enrichmentJobs.forEach((job) => {
      if (!latest.has(job.documentId)) latest.set(job.documentId, job);
    });
    return latest;
  }, [snapshot.enrichmentJobs]);

  const documentSourceCounts = useMemo(
    () => countDashboardDocumentsBySource(snapshot.documents),
    [snapshot.documents],
  );
  const visibleDocuments = useMemo(
    () => filterDashboardDocumentsBySource(snapshot.documents, documentSourceFilter),
    [documentSourceFilter, snapshot.documents],
  );

  const latestGitHubCapability = useMemo(() => [...githubState.capabilities]
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0], [githubState.capabilities]);
  const githubCapabilityGuidance = useMemo(
    () => resolveGitHubCapabilityGuidance(latestGitHubCapability),
    [latestGitHubCapability],
  );
  const displayedGitHubCapabilityLabel = githubCapabilityGuidance.status === "no_signal"
    ? "NO SIGNAL"
    : latestGitHubCapability
      ? githubCapabilityLabels[latestGitHubCapability.status]
      : "NO SIGNAL";

  const latestDiscoveryJob = useMemo(() => [...githubState.jobs]
    .filter((job) => job.kind === "discovery")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0], [githubState.jobs]);
  const discovery = latestDiscoveryJob?.result?.discovery;

  const latestPreviewJob = useMemo(() => [...githubState.jobs]
    .filter((job) => job.kind === "preview")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0], [githubState.jobs]);
  const preview = latestPreviewJob?.result?.preview;
  const repositoryDryRun = githubState.repositoryDryRun?.manifestDigest === preview?.manifestDigest
    ? githubState.repositoryDryRun
    : null;
  const latestApplyJob = useMemo(() => [...githubState.jobs]
    .filter((job) => job.kind === "apply")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0], [githubState.jobs]);
  const applyReceipt = latestApplyJob?.result?.apply;

  useEffect(() => {
    const hydrationKey = latestPreviewJob
      ? `preview:${latestPreviewJob.id}`
      : discovery
        ? `discovery:${discovery.selection.selectionDigest}`
        : "";
    if (!hydrationKey || selectionHydrationRef.current === hydrationKey) return;
    selectionHydrationRef.current = hydrationKey;
    setSelectedRepositoryIds(
      latestPreviewJob?.input.selectedRepositoryIds ?? discovery?.selection.selectedRepositoryIds ?? [],
    );
  }, [discovery, latestPreviewJob]);

  const selectedRepositorySet = useMemo(() => new Set(selectedRepositoryIds), [selectedRepositoryIds]);
  const repositorySyncById = useMemo(() => new Map(
    githubState.repositorySync.map((repository) => [repository.repositoryId, repository]),
  ), [githubState.repositorySync]);
  const repositorySyncTotals = useMemo(() => ({
    synced: githubState.repositorySync.filter((item) => item.status === "synced").length,
    syncing: githubState.repositorySync.filter((item) => item.status === "syncing").length,
    failed: githubState.repositorySync.filter((item) => item.status === "failed").length,
    pending: githubState.repositorySync.filter((item) =>
      item.status === "not_synced" || item.status === "cancelled").length,
  }), [githubState.repositorySync]);
  const repositorySyncHighlights = useMemo(() => githubState.repositorySync
    .filter((item) => item.status !== "not_synced")
    .slice(0, 8), [githubState.repositorySync]);
  const discoverySelectionById = useMemo(() => new Map(
    discovery?.selection.items.map((item) => [item.repositoryId, item]) ?? [],
  ), [discovery]);
  const visibleRepositories = useMemo(() => {
    const query = repositoryQuery.trim().toLowerCase();
    return (discovery?.repositories ?? []).filter((repository) => {
      const selection = discoverySelectionById.get(repository.repositoryId);
      if (query && !repository.name.toLowerCase().includes(query)) return false;
      if (repositoryFilter === "recommended" && !selection?.recommended) return false;
      if (repositoryFilter === "selected" && !selectedRepositorySet.has(repository.repositoryId)) return false;
      if (repositoryFilter === "public" && repository.visibility !== "public") return false;
      if (repositoryFilter === "private" && repository.visibility !== "private") return false;
      if (repositoryFilter === "warning" && !selection?.warning) return false;
      return true;
    });
  }, [discovery, discoverySelectionById, repositoryFilter, repositoryQuery, selectedRepositorySet]);

  const activeGitHubJob = githubState.jobs.find((job) => activeGitHubStatuses.has(job.status));
  const canStartGitHubDiscovery = !startingDiscovery
    && !activeGitHubJob
    && githubCapabilityGuidance.canRequestDiscovery;

  const startGitHubDiscovery = async () => {
    if (startingDiscovery || activeGitHubJob) return;
    setStartingDiscovery(true);
    setError("");
    try {
      await jsonRequest<{ job: GitHubSourceJobRecord }>("/api/github/source-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "discovery",
          owner: "coreline-ai",
          requestNonce: `dashboard-${Date.now().toString(36)}`,
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub 저장소 discovery를 시작하지 못했습니다.");
    } finally {
      setStartingDiscovery(false);
    }
  };

  const startGitHubPreview = async () => {
    if (
      startingPreview
      || activeGitHubJob
      || !selectedRepositoryIds.length
      || selectedRepositoryIds.length > githubPreviewMaxRepositories
    ) return;
    setStartingPreview(true);
    setError("");
    try {
      await jsonRequest<{ job: GitHubSourceJobRecord }>("/api/github/source-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "preview",
          owner: "coreline-ai",
          selectedRepositoryIds: [...selectedRepositoryIds].sort((left, right) => left.localeCompare(right)),
          requestNonce: `dashboard-preview-${Date.now().toString(36)}`,
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub 파일 미리보기를 시작하지 못했습니다.");
    } finally {
      setStartingPreview(false);
    }
  };

  const startGitHubApply = async () => {
    if (
      startingApply
      || activeGitHubJob
      || preview?.status !== "ready"
      || preview.selectedRepositoryIds.length !== 1
    ) return;
    setStartingApply(true);
    setError("");
    try {
      await jsonRequest<{ job: GitHubSourceJobRecord }>("/api/github/source-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "apply",
          owner: "coreline-ai",
          selectedRepositoryIds: preview.selectedRepositoryIds,
          manifestDigest: preview.manifestDigest,
          requestNonce: `dashboard-apply-${Date.now().toString(36)}`,
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub 저장소를 그래프에 적용하지 못했습니다.");
    } finally {
      setStartingApply(false);
    }
  };

  const retryGitHubRepository = async (repository: GitHubRepositorySyncSummary) => {
    const retry = repository.retry;
    if (!retry?.available || pendingGitHubRetry || activeGitHubJob) return;
    setPendingGitHubRetry(retry.jobId);
    setError("");
    try {
      await jsonRequest<{ job: GitHubSourceJobRecord }>(
        `/api/github/source-jobs/${encodeURIComponent(retry.jobId)}/retry`,
        { method: "POST" },
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : `${repository.repositoryName} 저장소를 다시 시도하지 못했습니다.`);
    } finally {
      setPendingGitHubRetry("");
    }
  };

  const toggleRepository = (repository: GitHubRepositoryDescriptor) => {
    setSelectedRepositoryIds((current) => current.includes(repository.repositoryId)
      ? current.filter((repositoryId) => repositoryId !== repository.repositoryId)
      : [...current, repository.repositoryId]);
  };

  const upload = async () => {
    if (!files.length || uploading) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file, file.name));
      const payload = await jsonRequest<{ snapshot: DashboardSnapshot }>("/api/documents", {
        method: "POST",
        body: form,
      });
      setSnapshot(payload.snapshot);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
      setDrawerOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "문서를 처리하지 못했습니다.");
    } finally {
      setUploading(false);
    }
  };

  const reindex = async (documentId: string) => {
    setError("");
    try {
      const payload = await jsonRequest<{ snapshot: DashboardSnapshot }>(
        `/api/documents/${encodeURIComponent(documentId)}/reindex`,
        { method: "POST" },
      );
      setSnapshot(payload.snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "재인덱싱하지 못했습니다.");
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setError("");
    try {
      const payload = await jsonRequest<{ snapshot: DashboardSnapshot }>(
        `/api/documents/${encodeURIComponent(pendingDelete.id)}`,
        { method: "DELETE" },
      );
      setSnapshot(payload.snapshot);
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "문서를 삭제하지 못했습니다.");
    }
  };

  const updateEnrichmentJob = async (jobId: string, action: "retry" | "cancel") => {
    const actionKey = `${action}:${jobId}`;
    if (pendingJobAction) return;
    setPendingJobAction(actionKey);
    setError("");
    try {
      const payload = await jsonRequest<{ snapshot: DashboardSnapshot }>(
        `/api/enrichment-jobs/${encodeURIComponent(jobId)}/${action}`,
        { method: "POST" },
      );
      setSnapshot(payload.snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "보강 작업을 변경하지 못했습니다.");
    } finally {
      setPendingJobAction("");
    }
  };

  const previewReprocess = async () => {
    if (reprocessing) return;
    setError("");
    try {
      const payload = await jsonRequest<ReprocessPreview>("/api/enrichment-jobs/reprocess", {
        cache: "no-store",
      });
      setReprocessPreview(payload);
      setReprocessProgress({ completed: 0, failed: 0 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "전체 재처리 규모를 계산하지 못했습니다.");
    }
  };

  const executeReprocess = async () => {
    if (!reprocessPreview || reprocessing) return;
    setReprocessing(true);
    setError("");
    setReprocessProgress({ completed: 0, failed: 0 });
    let completed = 0;
    let failed = 0;
    try {
      for (let offset = 0; offset < reprocessPreview.documents.length; offset += reprocessPreview.batchLimit) {
        const batch = reprocessPreview.documents
          .slice(offset, offset + reprocessPreview.batchLimit)
          .map((document) => document.documentId);
        const payload = await jsonRequest<{
          completedCount: number;
          failedCount: number;
          snapshot: DashboardSnapshot;
        }>("/api/enrichment-jobs/reprocess", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ documentIds: batch }),
        });
        completed += payload.completedCount;
        failed += payload.failedCount;
        setReprocessProgress({ completed, failed });
        setSnapshot(payload.snapshot);
      }
      setReprocessPreview(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "전체 문서 재처리가 중단되었습니다.");
    } finally {
      setReprocessing(false);
    }
  };

  return (
    <main className="control-room">
      <div className="control-room-atmosphere" aria-hidden="true" />
      <header className="control-room-header">
        <div className="control-room-brand">
          <span className="control-room-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <p>AI SYSTEMS ATLAS · CONTROL ROOM</p>
            <h1>문서 지식 관제실</h1>
          </div>
        </div>
        <div className="control-room-actions">
          <span className="sync-meta">
            <i /> {snapshot.documents[0] ? `마지막 반영 ${date.format(new Date(snapshot.documents[0].updatedAt))}` : "아직 반영된 문서 없음"}
          </span>
          <button type="button" className="primary-action" onClick={() => setDrawerOpen(true)}>
            <span>＋</span> Markdown 추가
          </button>
          <button
            type="button"
            className="ghost-action reprocess-action"
            disabled={reprocessing}
            onClick={() => void previewReprocess()}
          >관계 재처리 <span>↻</span></button>
          <Link href="/" className="ghost-action">지식 그래프 열기 <span>↗</span></Link>
        </div>
      </header>

      <section className="status-strip" aria-label="지식 저장소 현황">
        {[
          ["문서", snapshot.totals.documents],
          ["노드", snapshot.totals.nodes],
          ["관계", snapshot.totals.edges],
          ["보강 대기", snapshot.totals.enrichmentQueued],
          ["보강 중", snapshot.totals.enrichmentActive],
          ["주의", snapshot.totals.failed + snapshot.totals.enrichmentWarnings],
        ].map(([label, value], index) => (
          <span key={String(label)} className={index === 5 && Number(value) > 0 ? "has-error" : ""}>
            <small>{label}</small><strong>{number.format(Number(value))}</strong>
          </span>
        ))}
        <em>{snapshot.storage === "d1" ? "D1 PERSISTENT" : "LOCAL MEMORY"}</em>
      </section>

      {error && <div className="dashboard-error" role="alert"><span>!</span>{error}<button type="button" onClick={() => setError("")}>닫기</button></div>}

      {reprocessPreview && <section className="reprocess-preview" aria-live="polite">
        <div>
          <p>RELATION REPROCESS · SAFE BATCH</p>
          <h2>전체 Markdown을 최신 관계 규칙으로 재처리합니다.</h2>
          <span>
            {number.format(reprocessPreview.totals.documents)}개 문서 · {number.format(reprocessPreview.totals.repositories)}개 저장소 · {number.format(reprocessPreview.totals.blocks)}개 근거 블록 · 예상 {number.format(reprocessPreview.totals.chunks)}개 Codex 청크
          </span>
          <small>구조·명시 관계는 즉시 교체되고, 추론 관계는 로컬 Connector가 대기열을 순차 처리합니다.</small>
        </div>
        <div className="reprocess-preview-actions">
          {reprocessing && <strong>{number.format(reprocessProgress.completed + reprocessProgress.failed)} / {number.format(reprocessPreview.totals.documents)}</strong>}
          <button type="button" disabled={reprocessing} onClick={() => setReprocessPreview(null)}>닫기</button>
          <button type="button" className="primary-action" disabled={reprocessing} onClick={() => void executeReprocess()}>
            {reprocessing ? "재처리 중…" : "전체 재처리 시작"}
          </button>
        </div>
      </section>}

      <section className="github-discovery" aria-labelledby="github-discovery-title">
        <header className="github-discovery-heading">
          <div>
            <p>GITHUB SOURCE DISCOVERY · LOCAL GH</p>
            <h2 id="github-discovery-title">Coreline 저장소 선택</h2>
          </div>
          <div className="github-discovery-actions">
            <span className={`github-capability github-${githubCapabilityGuidance.status}`}>
              <i />{displayedGitHubCapabilityLabel}
            </span>
            <button
              type="button"
              className="primary-action"
              disabled={!canStartGitHubDiscovery}
              onClick={() => void startGitHubDiscovery()}
            >
              {startingDiscovery
                ? "요청 중…"
                : activeGitHubJob
                  ? "Discovery 진행 중"
                  : !githubCapabilityGuidance.canRequestDiscovery
                    ? githubCapabilityGuidance.actionLabel
                    : latestGitHubCapability?.status === "online"
                      ? discovery ? "저장소 다시 찾기" : "저장소 찾기"
                      : githubCapabilityGuidance.actionLabel}
              <span>↻</span>
            </button>
          </div>
        </header>

        {githubCapabilityGuidance.status !== "online" && <section
          className={`github-capability-guide tone-${githubCapabilityGuidance.tone}`}
          aria-label="GitHub Connector 복구 안내"
          aria-live="polite"
        >
          <span className="github-capability-guide-mark" aria-hidden="true"><i /><i /></span>
          <div className="github-capability-guide-copy">
            <p>CONNECTOR RECOVERY GUIDE</p>
            <strong>{githubCapabilityGuidance.title}</strong>
            <span>{githubCapabilityGuidance.description}</span>
          </div>
          <div className="github-capability-guide-step">
            <small>NEXT STEP</small>
            <span>{githubCapabilityGuidance.nextStep}</span>
            {githubCapabilityGuidance.retryAt && <time>
              제한 해제 예상 {date.format(new Date(githubCapabilityGuidance.retryAt))}
            </time>}
            {githubCapabilityGuidance.command && <code>{githubCapabilityGuidance.command}</code>}
          </div>
          <button
            type="button"
            disabled={!canStartGitHubDiscovery}
            onClick={() => void startGitHubDiscovery()}
          >{githubCapabilityGuidance.actionLabel}</button>
        </section>}

        <div className="github-discovery-body">
          <aside className="github-discovery-summary">
            <div className="github-account">
              <span className="github-account-mark" aria-hidden="true">GH</span>
              <p><strong>{latestGitHubCapability?.accountLogin ?? "coreline-ai"}</strong><small>{latestGitHubCapability?.message ?? "Connector를 실행하면 로컬 gh 로그인 상태를 확인합니다."}</small></p>
            </div>
            <div className="github-total"><span>접근 가능</span><strong>{number.format(discovery?.totals.total ?? 0)}</strong><small>REPOSITORIES</small></div>
            <dl className="github-metrics">
              <div><dt>PUBLIC</dt><dd>{number.format(discovery?.totals.public ?? 0)}</dd></div>
              <div><dt>PRIVATE</dt><dd>{number.format(discovery?.totals.private ?? 0)}</dd></div>
              <div><dt>RECOMMENDED</dt><dd>{number.format(discovery?.totals.recommended ?? 0)}</dd></div>
              <div><dt>SELECTED</dt><dd>{number.format(selectedRepositoryIds.length)}</dd></div>
              <div><dt>FORK</dt><dd>{number.format(discovery?.totals.fork ?? 0)}</dd></div>
              <div><dt>WARNINGS</dt><dd>{number.format(discovery?.totals.warnings ?? 0)}</dd></div>
            </dl>
            <div className="github-preview-controls">
              <div>
                <span>MANIFEST PREVIEW</span>
                <small>선택 저장소 1~{githubPreviewMaxRepositories}개 · 원문 다운로드 없음</small>
              </div>
              <div>
                <button type="button" onClick={() => setSelectedRepositoryIds([])} disabled={!selectedRepositoryIds.length}>전체 해제</button>
                <button
                  type="button"
                  className="preview-action"
                  disabled={
                    startingPreview
                    || Boolean(activeGitHubJob)
                    || !selectedRepositoryIds.length
                    || selectedRepositoryIds.length > githubPreviewMaxRepositories
                  }
                  onClick={() => void startGitHubPreview()}
                >
                  {startingPreview
                    ? "요청 중…"
                    : activeGitHubJob?.kind === "preview"
                      ? "미리보기 진행 중"
                      : `파일 미리보기 (${selectedRepositoryIds.length})`}
                </button>
              </div>
              {selectedRepositoryIds.length > githubPreviewMaxRepositories && <p role="status">
                안전한 선검증을 위해 {githubPreviewMaxRepositories}개 이하로 줄여주세요.
              </p>}
            </div>
            <p className="github-discovery-note">
              미리보기는 Git Tree·Contents 메타데이터만 읽습니다. README·dev-plan 원문 다운로드와 그래프 반영은 실행하지 않습니다.
            </p>
          </aside>

          <div className="github-repository-browser">
            <div className="github-repository-toolbar">
              <label><span>⌕</span><input value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} placeholder="저장소 이름 검색" /></label>
              <div role="group" aria-label="저장소 필터">
                {([
                  ["all", "전체"],
                  ["recommended", "권장"],
                  ["selected", "선택"],
                  ["public", "공개"],
                  ["private", "비공개"],
                  ["warning", "주의"],
                ] as const).map(([value, label]) => <button
                  key={value}
                  type="button"
                  className={repositoryFilter === value ? "active" : ""}
                  aria-pressed={repositoryFilter === value}
                  onClick={() => setRepositoryFilter(value)}
                >{label}</button>)}
              </div>
              <span>{visibleRepositories.length} / {discovery?.totals.total ?? 0}</span>
            </div>
            <div className="github-repository-list" role="list" aria-label="발견된 GitHub 저장소">
              {!discovery ? <div className="github-repository-empty">
                <strong>{activeGitHubJob ? "Connector가 저장소 목록을 확인하고 있습니다." : "아직 발견된 저장소가 없습니다."}</strong>
                <p>{activeGitHubJob ? "작업이 완료되면 수량·필터·선택 목록이 자동으로 갱신됩니다." : "로컬 Connector 연결 후 저장소 찾기를 실행하세요."}</p>
              </div> : visibleRepositories.length === 0 ? <div className="github-repository-empty"><strong>필터와 일치하는 저장소가 없습니다.</strong><p>검색어 또는 필터를 변경하세요.</p></div> : visibleRepositories.map((repository) => {
                const selection = discoverySelectionById.get(repository.repositoryId);
                const selected = selectedRepositorySet.has(repository.repositoryId);
                const sync = repositorySyncById.get(repository.repositoryId);
                return <label className={`github-repository-row ${selected ? "selected" : ""}`} key={repository.repositoryId} role="listitem">
                  <input type="checkbox" checked={selected} onChange={() => toggleRepository(repository)} />
                  <i aria-hidden="true" />
                  <span><strong>{repository.name}</strong><small>{sync?.lastSyncedAt
                    ? `${repository.defaultBranch} · 마지막 동기화 ${date.format(new Date(sync.lastSyncedAt))}`
                    : `${repository.defaultBranch} · 갱신 ${date.format(new Date(repository.updatedAt))}`}</small></span>
                  <span className="github-repository-badges">
                    {sync && <em className={`sync-${sync.status}`}>{repositorySyncLabels[sync.status]}</em>}
                    {selection?.warning && <em className="warning">TEST-LIKE</em>}
                    {repository.isFork && <em>FORK</em>}
                    {repository.isArchived && <em>ARCHIVED</em>}
                    {selection?.recommended && <em className="recommended">RECOMMENDED</em>}
                    <em className={repository.isPrivate ? "private" : "public"}>{repository.visibility.toUpperCase()}</em>
                  </span>
                  <a href={repository.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label={`${repository.name} GitHub 열기`}>↗</a>
                </label>;
              })}
            </div>
          </div>
        </div>

        <section className="github-repository-sync" aria-labelledby="github-repository-sync-title">
          <header>
            <div>
              <p>REPOSITORY SYNC STATUS · STORED GRAPH</p>
              <h3 id="github-repository-sync-title">저장소별 그래프 반영 상태</h3>
            </div>
            <dl>
              <div><dt>SYNCED</dt><dd>{repositorySyncTotals.synced}</dd></div>
              <div><dt>ACTIVE</dt><dd>{repositorySyncTotals.syncing}</dd></div>
              <div className={repositorySyncTotals.failed ? "has-error" : ""}><dt>ISSUES</dt><dd>{repositorySyncTotals.failed}</dd></div>
              <div><dt>WAITING</dt><dd>{repositorySyncTotals.pending}</dd></div>
            </dl>
          </header>
          {repositorySyncHighlights.length === 0 ? <div className="github-sync-empty">
            <strong>아직 그래프에 적용된 GitHub 저장소가 없습니다.</strong>
            <p>manifest에서 저장소 하나를 적용하면 마지막 동기화와 문서·노드·관계 수가 여기에 표시됩니다.</p>
          </div> : <div className="github-sync-grid">
            {repositorySyncHighlights.map((repository) => <article
              key={repository.repositoryId}
              className={`github-sync-card sync-${repository.status}`}
            >
              <header>
                <span><i />{repositorySyncLabels[repository.status]}</span>
                <code>{repository.commitSha?.slice(0, 8) ?? "NO COMMIT"}</code>
              </header>
              <h4>{repository.repositoryName}</h4>
              <dl>
                <div><dt>DOCS</dt><dd>{repository.documentCount}</dd></div>
                <div><dt>NODES</dt><dd>{number.format(repository.nodeCount)}</dd></div>
                <div><dt>EDGES</dt><dd>{number.format(repository.edgeCount)}</dd></div>
              </dl>
              {repository.errorMessage && <p role="status" title={repository.errorMessage}>
                <strong>{repository.errorCode ?? "unknown"}</strong>{repository.errorMessage}
              </p>}
              <footer>
                <time>{repository.lastSyncedAt
                  ? `마지막 동기화 ${date.format(new Date(repository.lastSyncedAt))}`
                  : repository.lastAttemptAt
                    ? `마지막 시도 ${date.format(new Date(repository.lastAttemptAt))}`
                    : "동기화 기록 없음"}</time>
                <span className="github-sync-actions">
                  {repository.retry && <button
                    type="button"
                    className="github-retry-action"
                    disabled={
                      !repository.retry.available
                      || Boolean(activeGitHubJob)
                      || Boolean(pendingGitHubRetry)
                    }
                    onClick={() => void retryGitHubRepository(repository)}
                    aria-label={`${repository.repositoryName} 저장소 동기화 다시 시도`}
                    title={!repository.retry.available
                      ? `수동 재시도 ${repository.retry.maxManualRetries}회를 모두 사용했습니다.`
                      : activeGitHubJob
                        ? "진행 중인 GitHub 작업이 끝난 뒤 다시 시도할 수 있습니다."
                        : "이 저장소의 실패한 Apply 작업만 다시 대기열에 추가합니다."}
                  >{pendingGitHubRetry === repository.retry.jobId
                      ? "요청 중…"
                      : !repository.retry.available
                        ? `재시도 소진 ${repository.retry.manualRetryCount}/${repository.retry.maxManualRetries}`
                        : activeGitHubJob
                          ? "다른 작업 진행 중"
                          : `개별 재시도 ${repository.retry.manualRetryCount}/${repository.retry.maxManualRetries}`}</button>}
                  {repository.documentCount > 0 && <Link
                    href={`/?scope=repository&repositoryId=${encodeURIComponent(repository.repositoryId)}`}
                  >그래프 열기 <span>↗</span></Link>}
                </span>
              </footer>
            </article>)}
          </div>}
        </section>

        <section className="github-manifest-preview" aria-labelledby="github-preview-title">
          <header>
            <div><p>LIVE MANIFEST PREVIEW · METADATA ONLY</p><h3 id="github-preview-title">README · dev-plan 대상 파일</h3></div>
            <span className={`preview-state preview-${preview?.status ?? latestPreviewJob?.status ?? "idle"}`}>
              <i />{preview?.status === "ready"
                ? "READY"
                : preview?.status === "blocked"
                  ? "BLOCKED"
                  : latestPreviewJob && activeGitHubStatuses.has(latestPreviewJob.status)
                    ? "PROCESSING"
                    : latestPreviewJob?.status === "failed"
                      ? "FAILED"
                      : "NOT RUN"}
            </span>
          </header>
          {!latestPreviewJob ? <div className="github-preview-empty">
            <strong>저장소를 최대 {githubPreviewMaxRepositories}개 선택하고 파일 미리보기를 실행하세요.</strong>
            <p>기본 브랜치의 루트 README.md와 dev-plan/**/*.md 경로·크기·Blob SHA만 확인합니다.</p>
          </div> : !preview ? <div className="github-preview-empty">
            <strong>{latestPreviewJob.status === "failed" ? "파일 미리보기를 완료하지 못했습니다." : "Connector가 선택 저장소의 Git Tree를 확인하고 있습니다."}</strong>
            <p>{latestPreviewJob.errorMessage ?? "완료되면 저장소별 대상 파일과 manifest digest가 표시됩니다."}</p>
          </div> : <>
            <dl className="github-preview-metrics">
              <div><dt>REPOSITORIES</dt><dd>{preview.totals.repositories}</dd></div>
              <div><dt>FILES</dt><dd>{preview.totals.files}</dd></div>
              <div><dt>README</dt><dd>{preview.totals.readme}</dd></div>
              <div><dt>DEV-PLAN</dt><dd>{preview.totals.devPlan}</dd></div>
              <div><dt>SIZE</dt><dd>{formatBytes(preview.totals.bytes)}</dd></div>
              <div><dt>SKIPPED</dt><dd>{preview.totals.skipped}</dd></div>
            </dl>
            {repositoryDryRun && <section className="github-dry-run" aria-labelledby="github-dry-run-title">
              <header>
                <div>
                  <p>SERVER DRY RUN · CURRENT STORED BLOBS</p>
                  <h4 id="github-dry-run-title">현재 그래프와 변경 계획 비교</h4>
                </div>
                <span className={`dry-run-state dry-run-${repositoryDryRun.status}`}>
                  <i />{repositoryDryRun.status === "ready" ? "SAFE TO APPLY" : "BLOCKED"}
                </span>
              </header>
              <dl className="github-dry-run-totals">
                <div className="action-create"><dt>CREATE</dt><dd>{repositoryDryRun.summary.createCount}</dd></div>
                <div className="action-update"><dt>UPDATE</dt><dd>{repositoryDryRun.summary.updateCount}</dd></div>
                <div className="action-delete"><dt>DELETE</dt><dd>{repositoryDryRun.summary.deleteCount}</dd></div>
                <div className="action-unchanged"><dt>UNCHANGED</dt><dd>{repositoryDryRun.summary.unchangedCount}</dd></div>
              </dl>
              <div className="github-dry-run-repositories">
                {repositoryDryRun.repositories.map((repository) => {
                  const changedActions = repository.actions.filter((action) => action.action !== "unchanged");
                  return <article key={repository.repositoryId}>
                    <header>
                      <strong>{repository.repositoryName}</strong>
                      <span>
                        +{repository.summary.createCount}
                        {' '}~{repository.summary.updateCount}
                        {' '}−{repository.summary.deleteCount}
                        {' '}={repository.summary.unchangedCount}
                      </span>
                    </header>
                    {repository.status === "blocked" ? <p className="github-dry-run-blocked">
                      manifest가 차단되어 삭제 계획을 생성하지 않았습니다. · {repository.blockedReason}
                    </p> : changedActions.length === 0 ? <p className="github-dry-run-clean">
                      현재 저장된 Blob과 같습니다. 변경 없이 {repository.summary.unchangedCount}개 문서를 재사용합니다.
                    </p> : <div className="github-dry-run-actions">
                      {changedActions.map((action) => <div key={`${action.action}:${action.sourceKey}`}>
                        <em className={`action-${action.action}`}>{action.action.toUpperCase()}</em>
                        <span><strong>{action.relativePath}</strong><small>
                          {action.previousBlobSha ? action.previousBlobSha.slice(0, 8) : "NEW"}
                          {' → '}
                          {action.nextBlobSha ? action.nextBlobSha.slice(0, 8) : "REMOVE"}
                        </small></span>
                      </div>)}
                    </div>}
                  </article>;
                })}
              </div>
            </section>}
            <div className="github-preview-repositories">
              {preview.repositories.map((repository) => <article key={repository.repositoryId}>
                <header>
                  <div><strong>{repository.repositoryName}</strong><small>{repository.defaultBranch} · {repository.commitSha.slice(0, 8)} · {repository.treeStrategy}</small></div>
                  <span className={repository.status}>{repository.status.toUpperCase()} · {repository.files.length} FILES</span>
                </header>
                {repository.status === "blocked" ? <p className="github-preview-blocked">{repository.blockedReason}</p> : repository.files.length === 0 ? <p className="github-preview-no-files">대상 README.md 또는 dev-plan Markdown이 없습니다.</p> : <div className="github-preview-files">
                  {repository.files.map((file) => <div key={file.sourceKey}>
                    <i className={`role-${file.role}`} />
                    <span><strong>{file.path}</strong><small>{file.role.toUpperCase()} · {formatBytes(file.size)} · {file.blobSha.slice(0, 8)}</small></span>
                    <a href={file.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${repository.repositoryName} ${file.path} 원본 위치 열기`}>↗</a>
                  </div>)}
                </div>}
              </article>)}
            </div>
            <footer>
              <span>MANIFEST <code>{preview.manifestDigest.slice(0, 12)}</code></span>
              <div className="github-apply-control">
                {preview.selectedRepositoryIds.length === 1 ? <button
                  type="button"
                  disabled={startingApply || Boolean(activeGitHubJob) || preview.status !== "ready"}
                  onClick={() => void startGitHubApply()}
                >{startingApply || activeGitHubJob?.kind === "apply" ? "적용 중…" : "이 저장소 그래프에 적용"}</button> : <small>P4-A는 저장소 1개만 적용할 수 있습니다.</small>}
                <time>{date.format(new Date(preview.generatedAt))}</time>
              </div>
            </footer>
            {latestApplyJob && <div className={`github-apply-status apply-${latestApplyJob.status}`}>
              <i />
              <span><strong>{applyReceipt
                ? `${applyReceipt.repositoryName} 적용 완료`
                : latestApplyJob.status === "failed"
                  ? "저장소 적용 실패"
                  : "저장소 원문 다운로드·원자적 적용 중"}</strong><small>{applyReceipt
                ? `${applyReceipt.fileCount}개 문서 · ${applyReceipt.nodeCount} 노드 · ${applyReceipt.edgeCount} 관계 · 생성 ${applyReceipt.createdCount} · 변경 ${applyReceipt.updatedCount} · 동일 ${applyReceipt.unchangedCount}`
                : latestApplyJob.errorMessage ?? "완료되면 문서 라이브러리와 그래프가 자동으로 갱신됩니다."}</small></span>
            </div>}
          </>}
        </section>
      </section>

      <div className="control-room-grid">
        <section className="document-library" aria-labelledby="document-library-title">
          <header className="panel-heading">
            <div><p>DOCUMENT LIBRARY</p><h2 id="document-library-title">Markdown 문서</h2></div>
            <span>{visibleDocuments.length.toString().padStart(2, "0")} / {snapshot.documents.length.toString().padStart(2, "0")} FILES</span>
          </header>

          {loading ? (
            <div className="dashboard-empty"><span className="loading-orbit" /><strong>문서 저장소 확인 중</strong><p>인덱싱 상태와 그래프 통계를 불러옵니다.</p></div>
          ) : snapshot.documents.length === 0 ? (
            <div className="dashboard-empty">
              <span className="empty-constellation" aria-hidden="true"><i /><i /><i /></span>
              <strong>아직 연결된 Markdown이 없습니다.</strong>
              <p>README와 설계 문서를 추가하면 제목·링크·명시적 패턴을 노드와 관계로 변환합니다.</p>
              <button type="button" onClick={() => setDrawerOpen(true)}>첫 문서 추가</button>
            </div>
          ) : <>
            <div className="document-source-toolbar" role="group" aria-label="문서 출처 필터">
              <span>DOCUMENT SOURCE</span>
              {(["all", "manual", "github"] as const).map((filter) => <button
                key={filter}
                type="button"
                className={documentSourceFilter === filter ? "active" : ""}
                aria-pressed={documentSourceFilter === filter}
                onClick={() => setDocumentSourceFilter(filter)}
              >{documentSourceFilterLabels[filter]} <strong>{documentSourceCounts[filter]}</strong></button>)}
              <small>{visibleDocuments.length} / {snapshot.documents.length}</small>
            </div>
            {visibleDocuments.length === 0 ? <div className="dashboard-empty document-source-empty">
              <span className={`source-empty-mark source-${documentSourceFilter}`} aria-hidden="true" />
              <strong>{documentSourceFilter === "github" ? "동기화된 GitHub 문서가 없습니다." : "수동 업로드 문서가 없습니다."}</strong>
              <p>{documentSourceFilter === "github"
                ? "저장소 Preview와 Apply를 완료하면 README와 dev-plan 문서가 이 목록에 표시됩니다."
                : "상단 Markdown 추가 버튼으로 로컬 문서를 직접 등록할 수 있습니다."}</p>
              <button type="button" onClick={() => setDocumentSourceFilter("all")}>전체 문서 보기</button>
            </div> : (
            <div className="document-table" role="table" aria-label="문서 목록">
              <div className="document-row document-head" role="row">
                <span>문서</span><span>기본 그래프</span><span>AI 보강</span><span>그래프</span><span>갱신</span><span>문서 작업</span>
              </div>
              {visibleDocuments.map((document) => {
                const enrichment = enrichmentByDocument.get(document.id);
                const canRetry = Boolean(
                  enrichment
                  && (enrichment.status === "failed" || enrichment.status === "warning")
                  && enrichment.manualRetryCount < enrichment.maxManualRetries,
                );
                const canCancel = Boolean(enrichment && activeEnrichmentStatuses.has(enrichment.status));
                return <div className="document-row" role="row" key={document.id}>
                  <span className="document-name"><i className={`source-dot source-${document.sourceType}`} /> <span><strong>{document.fileName}</strong><small><em className={`document-source-chip source-${document.sourceType}`}>{document.sourceType === "github" ? "GITHUB" : "MANUAL"}</em>{document.sourceLabel} · {document.parserVersion}</small></span></span>
                  <span><em className={`status-chip status-${document.status}`}><i />{statusLabels[document.status]}</em></span>
                  <span className="enrichment-state">
                    {enrichment ? <>
                      <em className={`enrichment-chip enrichment-${enrichment.status}`}>
                        <i />{enrichmentLabels[enrichment.status]}
                      </em>
                      <small title={enrichment.errorMessage}>
                        {enrichment.errorMessage
                          ? enrichment.errorMessage
                          : enrichment.status === "completed" || enrichment.status === "warning"
                            ? `${enrichment.relationCount}개 관계 · ${enrichment.warningCount}개 경고${enrichment.chunkCount ? ` · 청크 ${enrichment.chunkIndex}/${enrichment.chunkCount}` : ""}`
                            : `${enrichment.attemptCount}/${enrichment.maxAttempts}회 실행${enrichment.chunkCount ? ` · 청크 ${enrichment.chunkIndex}/${enrichment.chunkCount}` : ""}`}
                      </small>
                      {(canRetry || canCancel) && <span className="enrichment-actions">
                        {canRetry && <button
                          type="button"
                          disabled={Boolean(pendingJobAction)}
                          onClick={() => void updateEnrichmentJob(enrichment.id, "retry")}
                          aria-label={`${document.fileName} AI 보강 다시 시도`}
                        >{pendingJobAction === `retry:${enrichment.id}` ? "대기…" : `재시도 ${enrichment.manualRetryCount}/${enrichment.maxManualRetries}`}</button>}
                        {canCancel && <button
                          type="button"
                          className="cancel-enrichment"
                          disabled={Boolean(pendingJobAction)}
                          onClick={() => void updateEnrichmentJob(enrichment.id, "cancel")}
                          aria-label={`${document.fileName} AI 보강 취소`}
                        >{pendingJobAction === `cancel:${enrichment.id}` ? "취소 중…" : "취소"}</button>}
                      </span>}
                    </> : <><em className="enrichment-chip enrichment-none"><i />보강 없음</em><small>기본 그래프만 사용</small></>}
                  </span>
                  <span className="graph-count"><strong>{document.nodeCount}</strong> N · <strong>{document.edgeCount}</strong> E</span>
                  <span>{date.format(new Date(document.updatedAt))}</span>
                  <span className="row-actions">
                    <button type="button" onClick={() => void reindex(document.id)}>재인덱싱</button>
                    <button type="button" onClick={() => setPendingDelete(document)}>삭제</button>
                  </span>
                </div>;
              })}
            </div>
            )}
          </>}
        </section>

        <aside className="ingestion-activity" aria-labelledby="ingestion-title">
          <header className="panel-heading">
            <div><p>PIPELINE ACTIVITY</p><h2 id="ingestion-title">인덱싱 · 보강 상태</h2></div>
            <span className={`activity-live connector-${snapshot.connector.status}`}><i /> {snapshot.connector.status === "online" ? "CONNECTED" : "OFFLINE"}</span>
          </header>
          <section className={`connector-beacon connector-${snapshot.connector.status}`} aria-live="polite">
            <div className="connector-signal" aria-hidden="true"><i /><i /><span /></div>
            <div className="connector-copy">
              <p>CODEX CONNECTOR</p>
              <strong>{snapshot.connector.status === "online" ? "로컬 Connector 연결됨" : "Connector 오프라인"}</strong>
              <small>{snapshot.connector.status === "online"
                ? `${snapshot.connector.onlineCount}개 연결 · ${snapshot.connector.activeJobs ? `${snapshot.connector.activeJobs}개 분석 중` : "작업 대기 중"}`
                : snapshot.connector.queuedJobs
                  ? `${snapshot.connector.queuedJobs}개 보강 작업이 연결을 기다립니다.`
                  : "기본 그래프는 계속 사용할 수 있습니다."}</small>
            </div>
            <time>{snapshot.connector.lastSeenAt ? `마지막 신호 ${date.format(new Date(snapshot.connector.lastSeenAt))}` : "연결 기록 없음"}</time>
          </section>
          <section className="connector-run-policy" aria-label="Connector 제한 실행 상태">
            <header>
              <p>SAFE RUN POLICY</p>
              <strong>{snapshot.connector.runMode === "bounded" ? "제한 실행" : "연속 실행"}</strong>
              <em>{snapshot.connector.status === "online"
                ? "RUNNING"
                : snapshot.connector.stopReason
                  ? connectorStopReasonLabels[snapshot.connector.stopReason]
                  : "READY"}</em>
            </header>
            <dl>
              <div><dt>처리</dt><dd>{number.format(snapshot.connector.processedJobs ?? 0)}{snapshot.connector.maxJobs !== undefined ? ` / ${number.format(snapshot.connector.maxJobs)}` : ""}</dd></div>
              <div><dt>성공</dt><dd>{number.format(snapshot.connector.succeededJobs ?? 0)}</dd></div>
              <div><dt>주의</dt><dd>{number.format(snapshot.connector.warningJobs ?? 0)}</dd></div>
              <div><dt>실패</dt><dd>{number.format(snapshot.connector.failedJobs ?? 0)}</dd></div>
            </dl>
            <p>{snapshot.connector.runMode === "bounded"
              ? `최대 ${snapshot.connector.maxJobs ?? "–"}개 · ${runtimeLabel(snapshot.connector.maxRuntimeMs)} · 대기열 ${number.format(snapshot.connector.queuedJobs)}개`
              : `대기열 ${number.format(snapshot.connector.queuedJobs)}개 · 제한 실행은 npm run connector:batch`}</p>
            <small>{snapshot.connector.status === "online"
              ? "안전 중지: Connector 터미널에서 Ctrl+C"
              : snapshot.connector.queuedJobs
                ? "안전 재개: npm run connector:batch (기본 1개·최대 5분)"
                : "처리할 Codex 보강 작업이 없습니다."}</small>
          </section>
          <div className="pipeline-map" aria-label="문서 처리 단계">
            {[["01", "VALIDATE", "형식·크기·중복"], ["02", "PARSE", "Markdown AST"], ["03", "PROJECT", "기본 그래프 반영"], ["04", "ENRICH", "Codex 관계 보강"]].map(([step, title, description]) => (
              <div key={step}><span>{step}</span><i /><p><strong>{title}</strong><small>{description}</small></p></div>
            ))}
          </div>
          <div className="activity-list enrichment-activity-list">
            <div className="activity-heading"><span>AI 보강 작업</span><small>{snapshot.enrichmentJobs.length}</small></div>
            {snapshot.enrichmentJobs.length === 0 ? <p className="activity-empty">문서를 추가하면 선택 보강 작업이 여기에 표시됩니다.</p> : snapshot.enrichmentJobs.slice(0, 6).map((job) => {
              const document = snapshot.documents.find((item) => item.id === job.documentId);
              return <div className="activity-item" key={job.id}>
                <i className={`enrichment-${job.status}`} />
                <span><strong>{document?.fileName ?? "삭제된 문서"}</strong><small>{enrichmentLabels[job.status]} · 시도 {job.attemptCount}/{job.maxAttempts}</small></span>
                <em>{job.relationCount ? `${job.relationCount} R` : job.status.toUpperCase()}</em>
              </div>;
            })}
          </div>
          <div className="activity-list">
            <div className="activity-heading"><span>기본 인덱싱 기록</span><small>{snapshot.jobs.length}</small></div>
            {snapshot.jobs.length === 0 ? <p className="activity-empty">문서를 추가하면 처리 기록이 여기에 표시됩니다.</p> : snapshot.jobs.slice(0, 8).map((job) => (
              <div className="activity-item" key={job.id}>
                <i className={`status-${job.status}`} />
                <span><strong>{job.fileName}</strong><small>{job.message}</small></span>
                <em>{job.progress}%</em>
              </div>
            ))}
          </div>
          <footer>기본 그래프는 Connector와 무관하게 즉시 동작합니다. Codex 보강은 로컬 로그인 상태를 쓰는 별도 선택 단계입니다.</footer>
        </aside>
      </div>

      {drawerOpen && (
        <div className="upload-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !uploading) setDrawerOpen(false); }}>
          <aside className="upload-drawer" role="dialog" aria-modal="true" aria-labelledby="upload-title">
            <header><div><p>ADD KNOWLEDGE SOURCE</p><h2 id="upload-title">Markdown 문서 추가</h2></div><button type="button" onClick={() => setDrawerOpen(false)} disabled={uploading} aria-label="닫기">×</button></header>
            <div className="upload-content">
              <p className="upload-intro">문서 제목 계층, 링크, 인라인 코드와 <code>기능:</code>·<code>모듈:</code>·<code>의존성:</code> 패턴을 분석합니다.</p>
              <label className="dashboard-file-drop">
                <input ref={inputRef} type="file" accept=".md,.mdx,text/markdown" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
                <span>＋</span><strong>{files.length ? `${files.length}개 문서 선택됨` : "Markdown 선택"}</strong><small>MD · MDX / 파일당 2MB / 최대 20개</small>
              </label>
              {files.length > 0 && <div className="upload-file-list">{files.map((file) => <span key={`${file.name}-${file.size}`}><i />{file.name}<small>{Math.max(1, Math.round(file.size / 1024))}KB</small></span>)}</div>}
              <div className="upload-summary"><span>예상 입력</span><strong>{files.length} FILES · {Math.max(0, Math.round(selectedSize / 1024))} KB</strong></div>
            </div>
            <footer><button type="button" onClick={() => setDrawerOpen(false)} disabled={uploading}>취소</button><button type="button" className="primary-action" disabled={!files.length || uploading} onClick={() => void upload()}>{uploading ? "구조 분석 중…" : "그래프 생성 시작"}<span>→</span></button></footer>
          </aside>
        </div>
      )}

      {pendingDelete && (
        <div className="confirm-backdrop" role="presentation">
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <span className="danger-mark">!</span><p>REMOVE KNOWLEDGE SOURCE</p><h2 id="delete-title">{pendingDelete.fileName}을 삭제할까요?</h2><span>이 문서에서 생성된 전용 노드와 관계가 그래프에서 제거됩니다.</span>
            <div><button type="button" onClick={() => setPendingDelete(null)}>취소</button><button type="button" className="danger-action" onClick={() => void remove()}>문서 삭제</button></div>
          </div>
        </div>
      )}
    </main>
  );
}
