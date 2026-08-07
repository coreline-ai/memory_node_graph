# AI Systems Atlas

Markdown 문서를 규칙 기반으로 파싱해 노드·관계를 만들고, 발광형 Three.js 지식 그래프에서 세 가지 관점으로 탐색하는 웹앱입니다.

외부 LightRAG 서버나 OpenAI API 키 없이 기본 인덱싱이 동작합니다. 선택형 Atlas Codex Connector는 로컬 `codex login` 상태를 사용해 문서 근거 기반 관계 보강과 Graph RAG 답변 생성을 비동기로 처리합니다.

## 주요 화면

### `/` — 지식 그래프

- `별자리`: 기존 Force 3D 그래프를 유지하는 기본 보기
- `성운`: 지식 분야별 클러스터와 클러스터 사이 브리지 보기
- `궤도`: 선택 노드를 중심으로 1-hop과 2-hop 관계 보기
- `기본`, `브라이트`, `초신성` 발광 프리셋과 항상 노출되는 `커스텀` 밝기·관계선·후광·입자 조절
- 하단 제어판은 보기·데이터와 연출·발광을 2단 관측 덱으로 배치해 화면 폭 안에서 잘리지 않도록 표시
- 필터, 검색, 상세 패널, 자동 회전, 라벨, 카메라 조작
- 구조·명시·추론·화면 관계 계층 필터와 계층별 실선·점선·흐름·밝기 표현
- 노드 상세에서 community·centrality·degree, 연결 관계 confidence·evidence·GitHub 원문 line 링크 확인
- `prefers-reduced-motion`에서는 자동 회전을 처음부터 켜지 않으며, 사용자가 직접 선택하면 저속으로 동작하고 현재 상태를 표시
- `V` 키로 보기 순환
- 공유 가능한 URL: `/?scope=corpus`, `/?scope=overview`, `/?scope=repository&repositoryId=...`, `/?view=orbit&node=...`
- 기본 화면은 전체 D1의 관계 차수·저장소 다양성·의미 유형을 기준으로 선택한 최대 500노드·2,000선 `corpus` 투영이며, D1 전체 수량·화면의 실제 관계·비저장 시각 연결 수를 분리해 표시
- 저장소·공유 기술 `overview`에서 저장소 노드 상세 패널을 열면 README·개발 계획·Phase·Task `repository` 그래프로 진입
- 상단 경로와 하단 `전체 저장소` 버튼으로 overview에 복귀하며 브라우저 앞·뒤 이동에도 scope·선택 노드·활성 필터를 복원
- GitHub 노드 상세 패널에서 저장소, 원문 경로, commit SHA, line 고정 원본 링크를 확인하고 Task는 완료·미완료 상태를 별도 배지로 표시
- 세 scope 모두 결정적 500노드·2,000선 상한과 생략 수 메타를 제공하며, `corpus`는 저장된 endpoint 사이의 실제 관계를 우선한 뒤 대형 화면에만 `display` 계층의 비저장 시각 연결을 추가함. 이 연결은 사실 관계·분석 지표·RAG·D1에 포함되지 않음
- 관계선 Shader는 geometry의 vertex color를 명시적으로 활성화하며, 초기 데이터 요청은 React Strict Mode 재실행에서도 취소된 첫 프레임 때문에 누락되지 않음
- 하단 데이터 메뉴의 `온톨로지 Gold Graph`에서 README와 대표 개발 계획 3개를 근거로 만든 68개 전문 노드·101개 관계 표본을 현재 별자리·성운·궤도 GUI로 검토
- Gold Graph는 공개 GitHub block·line evidence를 가진 읽기 전용 fixture이며 현재 D1·파서·영속 관계를 변경하지 않음

### `/dashboard` — Atlas Control Room

- `.md`, `.mdx` 파일 추가
- 파일별 처리 상태, 노드·관계 수, 갱신 시각 확인
- 문서 라이브러리에서 전체·수동 업로드·GitHub 동기화 source filter와 저장소·상대 경로를 확인
- 동일 파일 SHA-256 비교와 `unchanged` 처리
- 재인덱싱과 삭제
- 최근 처리 기록과 저장소 상태 확인
- `보강 대기·실행·완료·경고·실패` 상태와 Connector 온라인 여부 확인
- 실패·경고 작업은 최대 2회 수동 재시도, 대기·실행 작업은 취소
- `관계 재처리`에서 전체 Markdown·저장소·근거 블록·예상 Codex 청크 수를 미리 확인하고 최대 20문서 안전 배치로 최신 규칙을 적용
- 로컬 `gh auth`로 보이는 `coreline-ai` 저장소 discovery·선택
- 선택 저장소의 `README.md`, `dev-plan/**/*.md` metadata-only manifest preview
- 승인한 단일 저장소 preview를 Connector로 다운로드·검증·파싱한 뒤 저장소 단위로 그래프에 원자 적용
- 적용 완료 후 생성·갱신·유지·삭제 문서와 노드·관계 수를 영수증으로 확인
- 저장소별 `미동기화·동기화 중·완료·실패·취소` 상태와 마지막 동기화, commit, 문서·노드·관계 수를 저장된 그래프 기준으로 확인
- 동기화 실패가 발생해도 이전 정상 그래프의 수량·마지막 성공 시각을 유지하면서 최신 오류 코드와 메시지를 함께 표시
- 실패한 저장소 카드에서 해당 Apply 작업만 최대 2회 개별 재시도하며, 한도 소진·다른 GitHub 작업 진행 중 상태를 버튼에 표시
- GitHub 로그인 필요·권한 부족·rate limit·Connector 오프라인·신호 없음은 자격 증명 없이 상태별 복구 안내와 로컬 확인 명령으로 구분
- capability 신호가 45초를 넘기면 이전 `GH ONLINE` 기록을 신뢰하지 않고 `NO SIGNAL`로 전환
- 최신 완료 Preview와 현재 저장된 source key·Blob SHA를 서버에서 다시 비교해 저장소별 `CREATE·UPDATE·DELETE·UNCHANGED` 적용 계획을 확인
- 차단된 manifest는 기존 문서가 있어도 삭제 계획을 만들지 않으며, 변경 경로와 이전·다음 Blob SHA는 Apply 전에만 표시
- 서버가 현재 Blob 상태로 재사용 계획을 승인하고, 동일 Blob은 Connector 원문 다운로드·재파싱 없이 `unchanged`로 유지
- 같은 저장소의 활성 Apply는 하나로 합쳐 중복 실행을 차단
- 그래프 commit 후 작업 완료 기록이 실패해도 저장된 영수증으로 안전하게 결과 제출을 복구
- 512KB를 넘거나 변경 문서가 20개를 초과하는 원문은 문서 경계 기준 `최대 20파일·5MB` chunk로 임시 stage하고, chunk checksum과 전체 digest를 모두 검증한 뒤 적용
- stage는 순차 업로드하며 checksum·순서·manifest 무결성 거부 시 즉시 초기화합니다. 검증 후 저장 실패와 Lease 재할당 동안은 보존하고 성공·취소·최종 실패 시 정리합니다.
- 저장소 하나는 최대 500개 Markdown·8MB까지 허용하며, Graph·문서·작업 stage 쓰기는 90문장 단위로 분할합니다.
- 최종 저장소 교체는 staged 문서·작업·대상 집합을 사용하는 90문장 이하의 단일 D1 transaction으로 적용하므로 20파일을 넘는 저장소도 부분 반영되지 않습니다.

## 처리 구조

```mermaid
flowchart LR
  U["Markdown 추가"] --> V["형식·크기·해시 검증"]
  V --> P["Remark Markdown AST"]
  P --> E["규칙 기반 노드·관계 추출"]
  E --> D["Cloudflare D1 저장"]
  D --> K["별칭 통합·교차 문서 mention"]
  K --> A["커뮤니티·중심성·품질 분석"]
  A --> G["Scope별 GraphSnapshot 투영"]
  G --> R["Three.js 3-View Renderer"]
  D --> Q["Enrichment Job"]
  C["로컬 Atlas Codex Connector"] -->|"Claim·Lease"| Q
  C --> S["공식 Codex SDK·기존 로그인"]
  C -->|"검증된 관계 결과"| D
  D --> QR["FTS·1/2-hop Graph Retrieval"]
  QR --> QA["Graph Answer Job"]
  C -->|"Claim·Lease"| QA
  QA -->|"인용 재검증 답변"| QR
  H["로컬 gh auth"] --> GC["GitHub Source Connector"]
  GC -->|"Discovery·Preview"] GP["승인된 Manifest"]
  GP -->|"Blob SHA 검증"] GS["문서 경계 Stage·Checksum"]
  GS -->|"단일 저장소 원자 Apply"] D
```

### 규칙 기반 추출

- 문서 루트와 제목 계층
- Markdown 링크
- 인라인 코드
- `기능:`, `모듈:`, `의존성:`, `결정:`, `위험:`, `도구:`, `개념:` 패턴
- `Phase`, `P5-I`, `DEV-001` 식별자와 선후·의존·차단 관계
- API·파일·DB table·package·검증 명령과 `calls`, `tests`, `reads_from`, `writes_to`, `produces`, `mitigates` 명시 관계
- 모든 기본 인덱싱은 외부 LLM 없이 완료

### GitHub Markdown parser profile

- 수동 업로드는 기존 `generic` 추출기를 그대로 사용합니다.
- GitHub 루트 `README.md`는 프로젝트·목적·기능·기술·설치·운영 섹션을 추출합니다.
- GitHub `dev-plan/**/*.md`는 Plan·Phase·체크박스 Task·위험·결정·의존성·완료 조건을 추출합니다.
- 저장소·문서·섹션·Phase·Task는 source-local ID를 사용하고, 명시적으로 확인된 기술과 HTTP(S) URL만 저장소 간 공유합니다.
- parser v4는 `documents`, `plans`, `contains` 구조 관계와 명시 관계를 분리하고, 긴 문서도 중요도 기반 최종 예산으로 후반 의미 노드를 보존합니다.
- GitHub 관계와 node mention은 commit 고정 원문 line URL을 근거로 보존합니다.
- HTML·스크립트·명령형 문구는 실행하지 않고 Markdown 텍스트로만 취급합니다.
- apply 작업 결과에는 원문 payload를 저장하지 않고 commit·manifest·처리 수량 영수증만 남깁니다.
- 대용량 apply 원문은 `github_apply_stage_chunks`에 임시 저장되며, 최종 영수증에는 포함되지 않고 성공·취소·재시도 소진 시 삭제됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

- 그래프: `http://localhost:3000/`
- 대시보드: `http://localhost:3000/dashboard`

D1 스키마는 첫 저장소 접근 시 자동 생성됩니다. 정식 마이그레이션 SQL은 `drizzle/0001_atlas_documents.sql`부터 `drizzle/0013_graph_answer_jobs.sql`까지 순서대로 관리합니다.

다른 터미널에서 기존 ChatGPT/Codex 로그인을 사용하는 Connector를 실행합니다. OpenAI API 키는 사용하지 않습니다.

```bash
codex login status
npm run connector:start
```

한 작업만 처리하고 종료하려면 `npm run connector:once`, 실제 Codex 구조화 호출만 점검하려면 `npm run connector:smoke`를 사용합니다. 10,903개와 같은 큰 보강 대기열은 연속 실행 전에 아래 제한 실행으로 확인합니다.

```bash
# 작업을 Claim하지 않고 현재 대기 수와 실행 정책만 확인
npm run connector:dry-run

# 기본 1개·최대 5분·Codex 보강만 처리
npm run connector:batch

# 검토된 소규모 N개 배치. 한 번에 최대 100개
npm run connector:batch -- --max-jobs=5 --max-runtime-ms=900000
```

제한 실행은 시작 전 대기 작업 수와 완료 후 성공·주의·실패·잔여 수량을 JSON 영수증으로 출력합니다. 최대 실행 시간에 도달하면 활성 호출을 중단하고 해당 작업을 재시도 가능 상태로 보고합니다. 대시보드 `SAFE RUN POLICY`에서 최근 실행 상한·종료 이유·진행 수량을 확인하며, 실행 중 안전 중지는 Connector 터미널의 `Ctrl+C`, 재개는 새 제한 배치 실행으로 처리합니다.

### Graph RAG 근거 검색

`/api/graph/query`는 질문을 실행 명령이나 LLM prompt로 사용하지 않고 검색어로만 정규화합니다. D1 FTS5의 엔티티 label·summary·tag와 문서 block을 검색하고 최대 2-hop 관계를 확장한 뒤, 키워드 적합도·관계 confidence·부분 그래프 중심성·근거 완전성으로 정렬합니다.

```bash
curl --get --data-urlencode 'q=에이전트 메모리 검색' \
  'http://localhost:3000/api/graph/query?nodes=12&relations=24&citations=8'

curl -X POST 'http://localhost:3000/api/graph/query' \
  -H 'content-type: application/json' \
  -d '{"question":"에이전트 메모리 검색","limits":{"nodes":12,"relations":24,"citations":8}}'
```

응답은 관련 노드·관계·commit/line 고정 문서 인용과 `answerReady`를 반환합니다. 기본 요청은 검색 context만 제공하며 자연어 LLM 답변을 생성하지 않습니다. 노드·관계·인용 상한은 각각 48·96·24입니다.

실행 중인 로컬 Connector가 있을 때만 `generateAnswer: true`로 선택형 답변 작업을 등록합니다. Connector가 오프라인이거나 신호가 45초보다 오래되면 작업을 쌓지 않고 `connector_offline`과 검색 근거만 반환합니다. 답변 생성은 공식 Codex SDK와 기존 `codex login`을 사용하며 API 키를 사용하지 않습니다.

```bash
curl -X POST 'http://localhost:3000/api/graph/query' \
  -H 'content-type: application/json' \
  -d '{"question":"에이전트 메모리 검색","generateAnswer":true}'

# 202 응답의 answer.jobId를 조회
curl 'http://localhost:3000/api/graph/query-jobs/graph-answer%3A...'
```

답변 작업은 질문과 검색 context fingerprint로 멱등 등록됩니다. Codex 구조화 출력의 각 claim은 현재 context의 citation ID를 1개 이상 가져야 하며, 서버가 존재하지 않는 인용과 claims 밖 추가 단정을 거부한 뒤 검증된 `answer`, `citationIds`, `uncertainty`, `limitations`만 저장합니다. 실패 작업은 최대 2회 수동 재시도할 수 있고 대기·실행 작업은 취소할 수 있습니다.

전체 저장 문서를 최신 parser로 재처리하거나 실제 D1 scope 응답을 감사하려면 다음 명령을 사용합니다. 재처리는 실행 전 대상과 예상 청크 수만 출력하며, `--execute`를 명시해야 D1 백업 후 20문서 배치를 적용합니다.

```bash
npm run graph:reprocess
npm run graph:reprocess -- --execute
npm run graph:audit
```

### GitHub Discovery 실행 기록

2026-08-05에 인증된 로컬 `gh` Connector로 `coreline-ai` 저장소 discovery를 읽기 전용으로 실행했습니다. 결과는 총 **115개**(공개 79·비공개 36·fork 0·archived 0·template 0)입니다. 이 단계는 저장소 목록과 메타데이터만 로컬에 기록하며, 원격 GitHub 변경·문서 다운로드·preview·apply·배포를 수행하지 않습니다. 실제 동기화는 대시보드에서 사용자가 저장소를 확정하고 preview를 검토한 다음에만 진행합니다.

115개 전체 metadata-only Preview와 사용자 확인 뒤 저장소별 순차 수집을 완료했습니다. 실제 최신 단일 Preview 기준으로 문서가 있는 저장소 111개에서 Markdown **853개**(README 108개·`dev-plan` 745개, 13,901,332 bytes)를 저장했고, 대상 문서가 없는 저장소는 4개, blocked·failed는 0개입니다. 초기 전체 Preview 852개보다 1개 늘어난 것은 수집 도중 한 저장소의 원격 문서가 24개에서 25개로 변경됐기 때문입니다.

전체 문서는 dangling relation endpoint를 만들지 않는 parser v4로 재적용했습니다. D1 감사 결과 저장소별 영수증 불일치, 중복 source key, orphan block·mention·relation, staging 잔여 row가 모두 0건입니다. 실제 변경 없는 1문서 Apply도 `created 0 · updated 0 · unchanged 1 · deleted 0`으로 Blob 재사용을 확인했습니다.

```bash
# 로컬 서버와 gh/Codex Connector를 먼저 실행한 뒤
npm run github:collect-all -- \
  --source-receipt docs/github-full-preview-20260805.json \
  --checkpoint docs/github-full-collection-YYYYMMDD.checkpoint.json \
  --output-json docs/github-full-collection-YYYYMMDD.json \
  --output-md docs/github-full-collection-YYYYMMDD.md \
  --run-id collect-YYYYMMDD --retry-failed

# 수집 영수증과 로컬 D1 source identity·관계 endpoint·staging 잔여를 대조
npm run github:audit-all

# D1을 query-only로 열어 전체 Markdown·블록·현재 그래프 품질 분석
npm run github:analyze-corpus
```

`github:collect-all`은 저장소마다 최신 `preview → apply → receipt`를 직렬 처리하고 checkpoint를 원자 저장합니다. 중단 후 같은 명령을 실행하면 완료·빈 저장소를 건너뛰고 미완료 또는 `--retry-failed` 대상부터 재개합니다. 현재 로컬 정본 영수증은 `docs/github-full-reindex-20260805.json`, 감사 보고서는 `docs/github-full-reindex-audit-20260806.md`입니다. 이 파일들과 전체 corpus 분석 산출물은 비공개 저장소 메타데이터나 근거가 포함될 수 있어 `.gitignore`로 공개 Git 전달 대상에서 제외합니다. `github:audit-all`은 후속 parser v4 재처리로 달라지는 최초 Apply 노드·관계 수와 원본 수집 무결성을 혼동하지 않도록 문서·bytes·commit·source key·orphan·staging을 감사하고, 현재 그래프 수량·투영은 `npm run graph:audit`이 별도로 검증합니다.

후속 동기화는 `/api/github/incremental-sync` 하나를 사용합니다. `manual`·`schedule`·`webhook` trigger 모두 저장소마다 **1개 Preview 작업**을 등록하므로 한 저장소의 권한 상실·rate limit·원격 오류가 다른 저장소를 막지 않습니다. 완료된 Preview는 마지막 성공 `commitSha`·단일 저장소 `manifestDigest`와 현재 Blob dry-run을 대조해 `changed`·`unchanged`·`blocked`를 판정합니다. 예약·Webhook은 Preview까지만 가능하며 실제 Apply는 같은 `runId`의 완료 Preview 작업 ID를 사용자가 명시적으로 승인한 `manual` 요청만 등록합니다. `unchanged`는 Apply 작업을 만들지 않습니다.

```bash
# 수동·예약·Webhook이 공유하는 저장소별 Preview 진입점
curl -X POST 'http://localhost:3000/api/github/incremental-sync' \
  -H 'content-type: application/json' \
  -d '{"action":"preview","trigger":"manual","repositoryIds":["1322252398"],"runId":"sync-20260807"}'

# 상태·변경 dry-run·저장소별 실패/재시도 영수증 조회
curl 'http://localhost:3000/api/github/incremental-sync?runId=sync-20260807'

# Preview 검토 후 같은 run의 변경 저장소만 수동 승인
curl -X POST 'http://localhost:3000/api/github/incremental-sync' \
  -H 'content-type: application/json' \
  -d '{"action":"apply","trigger":"manual","repositoryIds":["1322252398"],"runId":"sync-20260807","approvedPreviewJobIds":["github-source:preview:..."]}'
```

Apply는 기존 단일 저장소 원자 commit·stage·영수증 경로를 그대로 사용합니다. 실패 시 이전 정상 문서·노드·관계를 유지하며 작업별 최대 2회 수동 재시도가 가능합니다. create·update·delete로 D1 문서·엔티티·관계 fingerprint가 바뀌면 다음 corpus 요청은 오래된 메모리 snapshot 대신 새 후보를 읽습니다.

전체 코퍼스 분석은 853개 문서·148,655개 블록을 수정 없이 읽고 정보 범주 후보, 반복 heading, 고유 원문과 복제 원문, 공유 기술, 현재 그래프 차수·연결 컴포넌트, Gold Graph 표본 후보를 계산합니다. 분석 전후 문서 fingerprint와 문서·블록·엔티티·관계·보강 작업 수가 같지 않으면 실패합니다. 결과는 `docs/knowledge-graph-corpus-analysis.md`와 `docs/knowledge-graph-corpus-snapshot-20260806.json`에서 확인합니다.

Phase 3 온톨로지 계약은 `docs/knowledge-graph-ontology-v1.md`, 검증된 기술 alias와 병합 금지 항목은 `app/lib/graph/entity-aliases.json`, 검토용 정본 표본은 `tests/fixtures/knowledge-graph/gold-memory-node-graph.json`에 있습니다. 로컬 UI에서는 하단 데이터 메뉴 또는 `http://localhost:3000/?showcase=gold&view=constellation`로 확인합니다.

### 전체 관계 그래프 재처리 기록

2026-08-06에 수집된 **853개 문서·148,655개 근거 블록**을 parser v4로 전부 재처리했습니다. 실패 문서는 0개이며 D1은 **89,669개 엔티티·94,488개 관계**(규칙 94,487개·Codex 근거 관계 1개)로 갱신됐습니다. 구조 관계 외에 `references` 21,265개, `same_as` 3,707개, `tests` 968개, `calls` 693개, `precedes` 261개, `depends_on` 136개 등이 source block과 GitHub line 근거로 저장됐습니다.

2026-08-07 최종 로컬 감사에서도 문서 853개·고유 엔티티 89,669개·관계 94,488개·대기 보강 10,903개가 유지됐습니다. 대시보드의 **99,393 노드**는 문서별 node count 합계이고, corpus 메타의 **89,669 노드**는 같은 의미 mention을 canonical entity로 통합한 고유 엔티티 수이므로 서로 다른 집계입니다. 실제 corpus 화면은 500노드·1,539개 실제 관계에 461개 비저장 시각 연결을 더한 2,000선, overview는 130노드·176관계, Gold 표본은 68노드·101관계, 최대 밀도 fixture는 500노드·2,000관계로 확인했습니다.

전체 문서는 16블록·2블록 overlap 기준 **10,904개 Codex 청크 작업**으로 등록했습니다. 로컬 OAuth Connector smoke 1개를 실제 실행해 `atlas-relations-v2-chunked` 결과 관계 1개와 원본 line evidence를 D1에 병합했으며, 나머지 10,903개는 외부 API 키 없이 로컬 Connector가 순차 처리할 대기 상태입니다. 실행 보고서는 `.wrangler/reports/full-reprocess-2026-08-06T17-46-32-545Z.json`에 있습니다.

실데이터 scope 감사에서 전체 `corpus`는 **500노드·1,539개 실제 관계**, 111개 저장소 overview는 130노드·176관계, `memory_node_graph` repository는 471노드·598관계로 투영됐습니다. 전체 `corpus`는 24개 대표 저장소와 고차수 의미 anchor 40개의 1-hop 후보에서 선택 집합의 실제 관계를 가장 많이 늘리는 노드를 반복 선택합니다. 화면에서는 분리된 실제 클러스터를 한 지식 우주로 읽을 수 있도록 공유 태그·분야 기반 `display` 연결 461개를 별도 계층으로 더합니다. `display` 연결은 `origin=display`, `provider=corpus-visual-weave-v1`로 식별되며 D1 저장, 근거 관계 수, 커뮤니티·중심성 분석, RAG 검색에 사용되지 않습니다. D1 관계 source/target index와 scope 전용 제한 조회를 적용했고 500노드·2,000선 표시 상한을 유지합니다.

반복 `corpus` 요청은 문서 최신 갱신 시각과 문서·엔티티·관계 수·row version으로 만든 fingerprint가 같을 때 제한 조회 후보 snapshot을 메모리에서 재사용합니다. 각 요청에는 복제본을 반환하므로 consolidation·analytics가 cache 원본을 오염시키지 않으며, 문서 재처리나 관계 보강으로 fingerprint가 바뀌면 다음 요청에서 D1을 다시 읽습니다.

## 환경 변수

기본 실행에는 환경 변수가 필요하지 않습니다.

그래프와 대시보드 읽기는 공개로 두고 문서 추가·삭제·재인덱싱만 OAuth 프록시 뒤에 둘 때 다음 값을 사용합니다.

```bash
ATLAS_WRITE_ACCESS=authenticated
```

이 모드는 신뢰 가능한 프록시가 클라이언트가 보낸 사용자 식별 헤더를 제거한 뒤 `oai-authenticated-user-id`, `x-openai-user-id`, `cf-access-authenticated-user-email` 중 하나를 주입하는 환경에서만 활성화해야 합니다. 로컬 데모 기본값은 `public`입니다.

로컬 `localhost` 개발은 Connector 토큰 없이 동작합니다. 호스팅에서는 웹앱과 Connector에 같은 고엔트로피 애플리케이션 토큰을 설정해야 합니다.

```bash
ATLAS_CONNECTOR_TOKEN=
ATLAS_BASE_URL=http://localhost:3000
```

`ATLAS_CONNECTOR_TOKEN`은 OpenAI 키가 아니라 Atlas 작업 API만 보호하는 애플리케이션 자격증명입니다. Codex 로그인 토큰은 로컬 Connector 밖으로 전달되지 않고 브라우저·D1·웹앱 환경 변수에도 저장되지 않습니다. Connector는 OpenAI 키 환경 변수를 제거한 자식 환경에서 공식 SDK를 실행합니다.

## API

| Method | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/graph`, `/api/graph?scope=corpus` | 전체 D1 관계 중심 500노드·최대 2,000선 snapshot; `projectedFactualEdgeCount`와 비저장 `displayEdgeCount`를 분리한 전체/표시 수량 메타 포함 |
| `GET` | `/api/graph?showcase=gold` | 온톨로지 v1 Gold Graph 읽기 전용 fixture; 현재 D1과 분리 |
| `GET` | `/api/graph?scope=overview` | 저장소·공유 기술 overview snapshot; 결정적 500노드·2,000관계 예산과 생략 수 메타 포함 |
| `GET` | `/api/graph?scope=repository&repositoryId=...` | 선택 GitHub 저장소의 README·개발 계획·Phase·Task 상세 snapshot |
| `GET`·`POST` | `/api/graph/query` | 질문 정규화, 엔티티·문서 FTS, 1/2-hop 관계 확장, 근거 context 반환; POST `generateAnswer`는 Connector 온라인 시 답변 작업 등록 |
| `GET` | `/api/graph/query-jobs/:id` | 답변 작업 상태와 서버 재검증 완료 결과 조회 |
| `POST` | `/api/graph/query-jobs/claim` | Connector가 답변 작업 한 개 Claim |
| `POST` | `/api/graph/query-jobs/:id/start` | 답변 작업 실행 시작 |
| `POST` | `/api/graph/query-jobs/:id/lease` | 답변 작업 Lease 갱신 |
| `POST` | `/api/graph/query-jobs/:id/result` | citation·claims를 재검증할 구조화 답변 제출 |
| `POST` | `/api/graph/query-jobs/:id/fail` | 답변 생성 실패·자동 재시도 보고 |
| `POST` | `/api/graph/query-jobs/:id/cancel` | 사용자 답변 작업 취소 |
| `POST` | `/api/graph/query-jobs/:id/retry` | 실패한 답변 작업 수동 재시도(최대 2회) |
| `GET` | `/api/documents` | 문서·작업·통계 목록 |
| `POST` | `/api/documents` | Markdown 추가·인덱싱 |
| `DELETE` | `/api/documents/:id` | 문서와 자동 그래프 데이터 삭제 |
| `POST` | `/api/documents/:id/reindex` | 저장 원문 재인덱싱 |
| `GET` | `/api/ingestion-jobs/:id` | 작업 상태 조회 |
| `POST` | `/api/enrichment-jobs/claim` | Connector가 작업 한 개 Claim |
| `POST` | `/api/enrichment-jobs/:id/start` | 작업 실행 시작 |
| `POST` | `/api/enrichment-jobs/:id/lease` | Lease 갱신 |
| `POST` | `/api/enrichment-jobs/:id/result` | 검증할 구조화 결과 제출 |
| `POST` | `/api/enrichment-jobs/:id/cancel` | 사용자 작업 취소 |
| `POST` | `/api/enrichment-jobs/:id/retry` | 실패·경고 작업 수동 재시도(최대 2회) |
| `POST` | `/api/enrichment-jobs/heartbeat` | Connector 온라인·오프라인·제한 실행 진행률·종료 영수증 기록 |
| `GET` | `/api/enrichment-jobs/reprocess` | 전체 또는 저장소별 문서·블록·예상 청크 재처리 규모 미리보기 |
| `POST` | `/api/enrichment-jobs/reprocess` | 최대 20문서 안전 배치 재색인·청크 작업 등록 |
| `GET`·`POST` | `/api/github/source-jobs` | GitHub discovery·preview·단일 저장소 apply 작업 조회·생성 |
| `GET`·`POST` | `/api/github/incremental-sync` | run별 저장소 격리 Preview, commit·manifest·Blob 변경 판정, 수동 승인 Apply 등록·영수증 조회 |
| `POST` | `/api/github/source-jobs/claim` | 로컬 Connector가 GitHub source 작업 Claim |
| `POST` | `/api/github/source-jobs/:id/stage` | 유효 Lease가 있는 대용량 Apply chunk 임시 저장·checksum 확인 |
| `POST` | `/api/github/source-jobs/:id/result` | 검증된 discovery·manifest·apply 결과 제출; apply 원문은 저장하지 않음 |

## 핵심 파일

| 역할 | 파일 |
|---|---|
| 그래프 UI·Three.js 렌더러 | `app/knowledge-graph.tsx` |
| 그래프 레이아웃 전략 | `app/graph/layouts.ts` |
| 그래프 scope 투영·예산 정책 | `app/lib/graph/scope-projection.ts` |
| 별칭 통합·교차 문서 관계 | `app/lib/graph/consolidation.ts`, `app/lib/graph/entity-alias-resolver.ts` |
| 커뮤니티·중심성·품질 분석 | `app/lib/graph/analytics.ts` |
| Graph RAG 검색·랭킹 | `app/lib/graph/graph-retrieval.ts`, `app/api/graph/query/route.ts` |
| Graph RAG 답변 계약·검증 | `app/lib/llm/graph-answer-contracts.ts`, `app/lib/llm/graph-answer-result-validator.ts` |
| Graph RAG 답변 작업 저장소·API | `app/lib/storage/graph-answer-job-repository.ts`, `app/api/graph/query-jobs/` |
| 그래프 scope URL·API 전환 계약 | `app/lib/graph/scope-navigation.ts` |
| GitHub line evidence·노드 원본 메타 투영 | `app/lib/graph/source-metadata.ts` |
| 온톨로지 v1 Gold Graph schema·fixture loader | `app/lib/graph/gold-graph-schema.ts`, `app/lib/graph/gold-graph-fixture.ts` |
| 확인된 entity alias | `app/lib/graph/entity-aliases.json` |
| GitHub 저장소별 대시보드 상태 투영 | `app/lib/github/dashboard-projection.ts` |
| GitHub Preview·현재 Blob dry-run 투영 | `app/lib/github/dashboard-dry-run.ts` |
| GitHub 증분 변경 판정·공통 작업 API | `app/lib/github/incremental-sync.ts`, `app/api/github/incremental-sync/route.ts` |
| GitHub Connector 상태별 복구 안내 | `app/lib/github/capability-guidance.ts` |
| 대시보드 문서 출처 filter 계약 | `app/lib/dashboard/document-source-filter.ts` |
| 대시보드 | `app/dashboard/` |
| Markdown AST 파서 | `app/lib/markdown/parse-markdown.ts` |
| 규칙 추출기 | `app/lib/markdown/extract-graph.ts` |
| README·dev-plan parser profile | `app/lib/markdown/parser-profiles.ts` |
| GitHub apply 계약·stage·서비스 | `app/lib/github/apply-contracts.ts`, `app/lib/github/apply-stage-contracts.ts`, `app/lib/github/apply-service.ts` |
| 문서 처리 서비스 | `app/lib/ingestion/ingestion-service.ts` |
| 청크 보강 등록·전체 재처리 | `app/lib/ingestion/enrichment-scheduler.ts`, `app/api/enrichment-jobs/reprocess/route.ts` |
| D1·메모리 저장소 | `app/lib/storage/graph-repository.ts` |
| D1 Graph batch 정책 | `app/lib/storage/d1-batch-policy.ts` |
| 보강 작업 저장소 | `app/lib/storage/enrichment-job-repository.ts` |
| 결과 검증기 | `app/lib/llm/enrichment-result-validator.ts` |
| 로컬 Codex Connector | `connector/` |
| Drizzle 스키마 | `db/schema.ts` |
| D1 SQL | `drizzle/0001_atlas_documents.sql` ~ `drizzle/0013_graph_answer_jobs.sql` |

## 검증

```bash
npx tsc --noEmit
npm run lint
npm test
```

`npm test`는 프로덕션·Connector 빌드 후 그래프 scope·예산·Graph RAG 검색·OAuth 답변 작업·인용 재검증·오프라인 fallback·timeout 복구, GitHub 원본 근거·이력 복원, 저장소별 증분 변경 판정·격리 Preview·수동 승인 Apply·dry-run·개별 재시도·문서 출처 filter·GitHub 복구 안내·만료 신호 상태, 대시보드, Markdown API, 청크 작업 API, Lease 상태 전이, evidence 병합과 Connector 제한·순차 실행을 확인합니다. 현재 전체 152개 테스트를 통과합니다.

성능 HUD와 500 노드·2,000 관계 로컬 fixture는 개발 서버에서 다음 주소로 확인합니다.

```text
http://localhost:3000/?fixture=500x2000&perf=1
```

운영 OAuth 프록시가 공개 읽기·미인증 쓰기·위조 식별 헤더 정책을 지키는지는 staging 주소에서 검증합니다.

```bash
npm run verify:oauth -- --base-url=https://staging.example.com
```

## 배포

구현과 로컬 검증만 수행합니다. 별도 사용자 승인 전에는 배포하지 않습니다.
