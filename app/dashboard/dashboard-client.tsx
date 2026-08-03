"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  DashboardEnrichmentJob,
  DashboardSnapshot,
  DocumentRecord,
} from "../lib/graph/model";

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

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `요청 실패 (${response.status})`);
  return payload;
}

export default function DashboardClient() {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [pendingJobAction, setPendingJobAction] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await jsonRequest<DashboardSnapshot>("/api/documents", { cache: "no-store" }));
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

      <div className="control-room-grid">
        <section className="document-library" aria-labelledby="document-library-title">
          <header className="panel-heading">
            <div><p>DOCUMENT LIBRARY</p><h2 id="document-library-title">Markdown 문서</h2></div>
            <span>{snapshot.documents.length.toString().padStart(2, "0")} FILES</span>
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
          ) : (
            <div className="document-table" role="table" aria-label="문서 목록">
              <div className="document-row document-head" role="row">
                <span>문서</span><span>기본 그래프</span><span>AI 보강</span><span>그래프</span><span>갱신</span><span>문서 작업</span>
              </div>
              {snapshot.documents.map((document) => {
                const enrichment = enrichmentByDocument.get(document.id);
                const canRetry = Boolean(
                  enrichment
                  && (enrichment.status === "failed" || enrichment.status === "warning")
                  && enrichment.manualRetryCount < enrichment.maxManualRetries,
                );
                const canCancel = Boolean(enrichment && activeEnrichmentStatuses.has(enrichment.status));
                return <div className="document-row" role="row" key={document.id}>
                  <span className="document-name"><i /> <span><strong>{document.fileName}</strong><small>{document.parserVersion}</small></span></span>
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
                            ? `${enrichment.relationCount}개 관계 · ${enrichment.warningCount}개 경고`
                            : `${enrichment.attemptCount}/${enrichment.maxAttempts}회 실행`}
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
