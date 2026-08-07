# Knowledge Graph Ontology v1

> **문서 역할:** 이 온톨로지는 규칙·Codex 관계 결과의 검증 기준으로 계속 유효하다. Codex 실행은 OpenAI API Key 없이 [현재 OAuth 런타임 방향](./current-oauth-runtime.md)을 따른다.

작성 일시: `2026-08-06 KST`

## 목적과 적용 범위

이 문서는 853개 GitHub Markdown 코퍼스 분석 결과를 바탕으로 AI Systems Atlas가 구조 트리 위주의 그래프를 근거 있는 의미 그래프로 확장할 때 사용하는 첫 온톨로지 계약이다. Phase 3의 Gold Graph fixture에 먼저 적용하며, 사용자 승인 전에는 현재 D1 정본·Markdown 파서·영속 관계 스키마를 변경하지 않는다.

코퍼스 기준선은 다음과 같다.

- 문서 853개, Markdown 블록 148,655개
- 현재 엔티티 84,665개, 관계 85,662개
- `contains` 78,168개(91.3%), 차수 1 노드 64,657개(76.4%)
- 같은 정규화 라벨 그룹 6,514개. `구현 태스크`, `자체 테스트`, `목표`, `완료 조건`은 의미 허브로 자동 승격하면 안 되는 대표 템플릿 라벨이다.
- 휴리스틱만으로 타입을 확정할 수 없는 블록 72,759개(49.2%)는 `ambiguous`로 남기며 억지로 의미 노드로 만들지 않는다.

## 계층

| 계층 | 목적 | 예시 | 영속 사실 여부 |
|---|---|---|---|
| 구조 관계 | 문서 원래 계층과 소속을 보존 | `documents`, `plans`, `contains` | 예 |
| 명시 관계 | 원문 문장·표·링크·코드에서 직접 확인 | `uses`, `calls`, `requires`, `tests` | 예 |
| 추론 관계 | 제한된 규칙 또는 Codex가 근거 블록으로 제안 | `depends_on`, `mitigates`, `related_to` | 검증 후 후보→사실 |
| 표시 관계 | 레이아웃과 탐색을 돕는 일시적 연결 | community bridge, similarity | 아니요 |

표시 관계는 사실 관계 API와 분리하고 D1의 정본 관계로 취급하지 않는다.

## 노드 타입

### Core ontology

| 타입 | 승격 조건 | 대표 제외 조건 |
|---|---|---|
| `project` | 저장소 또는 제품을 독립적으로 설명하고 기능·구성요소·문서 중 하나 이상과 연결 | 단순 저장소명 언급 |
| `document` | 수집된 README/dev-plan의 source identity와 commit 고정 원문이 존재 | 외부 링크 라벨만 있는 문서명 |
| `component` | 책임·경계가 있는 실행 또는 UI 구성요소이며 다른 노드와 동작 관계가 존재 | 일반적인 `모듈`, `서비스` heading |
| `feature` | 사용자가 관찰할 수 있는 기능이며 구현 주체 또는 검증 근거가 존재 | 희망·아이디어만 있는 항목 |
| `workflow` | 순서가 있는 2단계 이상의 처리 흐름이며 입력·출력 또는 선후 관계가 존재 | 순서 없는 기능 목록 |
| `api` | HTTP method+path, 함수 계약 또는 명시적 호출 경계가 존재 | URL 예시 문자열, 임의 슬래시 경로 |
| `data` | 이름·형식·생산자·소비자 중 둘 이상이 식별되는 데이터/record/job | 일반 명사 `데이터`, 예시 payload 값 |
| `storage` | 실제 저장 책임과 읽기/쓰기 주체가 확인되는 DB·table·store | 기술 후보로만 나열된 DB |
| `file` | 프로젝트 역할이 설명된 source-local 파일 경로 | 코드 블록의 임시 경로, glob만 존재 |
| `technology` | 패키지·프레임워크·런타임이 실제 사용/의존 관계로 확인 | 비교 후보 목록, 단순 배지 |
| `decision` | 선택·제외·고정·우선순위가 명시되고 영향을 받는 대상이 존재 | 일반적인 조언 또는 과거 회의 메모 |
| `risk` | 실패 조건·영향·대응 중 둘 이상이 확인 | `주의`, `리스크` heading 자체 |
| `test` | 검증 대상과 명령/기대 결과 중 하나 이상이 확인 | `자체 테스트` heading, 통과 주장만 존재 |

### Project extension

| 타입 | 승격 조건 | 범위 |
|---|---|---|
| `repository` | GitHub repository ID, owner/name, commit 기준이 존재 | overview 전용 프로젝트 컨테이너 |
| `phase` | `Phase N`, `P5-I`처럼 문서 안에서 안정적으로 참조되고 작업 또는 선후 관계가 존재 | source-local |
| `task` | `DEV-001` 또는 체크리스트 항목이 책임·상태·Phase 중 하나와 연결 | source-local |

`repository`, `document`, `phase`, `task`, section은 source-local ID를 유지한다. 여러 문서의 라벨이 같다는 이유만으로 canonical node로 병합하지 않는다.

## 공통 승격 조건

후보는 아래 세 조건을 모두 충족해야 의미 노드가 된다.

1. **독립 참조 가능:** 라벨이 해당 문맥 밖에서도 대상을 식별한다.
2. **의미 관계 존재:** 구조 `contains` 외에 구현·사용·호출·검증·위험·선후 관계 중 하나 이상을 만들 수 있다.
3. **유효한 근거:** 현재 document hash에 속한 block ID와 commit 고정 GitHub line URL이 있다.

불확실한 후보는 삭제하지 않고 mention 또는 `ambiguous` 분석 항목으로 유지한다. 모든 heading과 checklist를 자동 승격하지 않는다.

## 관계 계약

| 관계 | 방향 | 허용 source → target | 기본 계층 | 최소 confidence | 필수 근거 |
|---|---|---|---|---:|---|
| `documents` | 문서화 주체→문서 | project/repository→document | 구조 | 1.00 | source identity |
| `plans` | 계획 문서→대상 | document→project/component/feature/workflow | 구조 | 0.95 | 계획의 목적/범위 block |
| `contains` | 컨테이너→구성 | project/repository/document/component/workflow/phase→document/component/workflow/feature/api/data/storage/phase/task | 구조 | 1.00 | AST 계층 또는 source identity |
| `implements` | 구현 주체→기능/API/workflow | project/component→feature/api/workflow | 명시 | 0.85 | 구현을 표현한 동일 block |
| `depends_on` | 의존 주체→의존 대상 | project/component/feature/workflow→component/technology/storage/api/data | 명시/추론 | 0.80 | 의존 표현 또는 2개 이상 보강 근거 |
| `calls` | 호출자→피호출자 | component/feature/workflow/api→api/component/workflow | 명시 | 0.90 | 호출 method/path/계약 |
| `reads_from` | 소비자→저장/데이터 | component/feature/workflow/api→storage/data | 명시 | 0.90 | 조회/읽기 표현 |
| `writes_to` | 생산자→저장 | component/workflow/api→storage | 명시 | 0.90 | 저장/제출/갱신 표현 |
| `produces` | 생산자→산출물 | component/workflow/api→data/document | 명시 | 0.85 | 출력/결과 표현 |
| `tests` | 테스트→검증 대상 | test→project/component/feature/api/workflow | 명시 | 0.90 | 명령 또는 기대 결과 |
| `references` | 참조자→대상 | document/file/task→document/file/api/technology | 명시 | 0.95 | Markdown link, path, ID |
| `precedes` | 선행 단계→후행 단계 | workflow/phase/task→workflow/phase/task | 명시 | 0.90 | 순서 또는 pipeline |
| `blocks` | 차단 조건→대상 | risk/task→feature/workflow/phase/task | 명시 | 0.85 | 차단 조건과 대상 |
| `supersedes` | 새 결정/단계→이전 대상 | decision/phase/document→decision/phase/document | 명시 | 0.90 | 대체/폐기 문장과 양쪽 근거 |
| `same_as` | mention→canonical | 같은 semantic type | 추론 | 0.95 | alias 사전 또는 양쪽 식별 근거 |
| `mentions` | 문서/블록→개체 | document→모든 의미 타입 | 명시 | 0.70 | 동일 block 언급 |
| `related_to` | 결정적으로 정렬한 양방향 의미 | project/component/feature/technology↔동일 범주 | 추론 | 0.70 | 서로 다른 2개 이상의 근거 |
| `supports` | 지원 주체→대상 | component/feature/decision/test→project/component/feature/workflow | 명시/추론 | 0.80 | 지원 효과와 대상 |
| `extends` | 확장 주체→기존 대상 | project/component/feature/api→같은 범주 | 명시 | 0.85 | 확장 표현 |
| `requires` | 요구 주체→필수 대상 | project/component/feature/workflow/decision→component/workflow/technology/storage/data/decision | 명시 | 0.85 | 필수/요구 표현 |
| `uses` | 사용 주체→기술/도구 | project/component/workflow→technology/api/storage | 명시 | 0.90 | 실제 사용 표현 |
| `mitigates` | 대응→위험 | decision/test/component→risk | 명시/추론 | 0.80 | 위험과 대응 근거 |
| `risks` | 위험 보유 대상→위험 | project/component/workflow/decision→risk | 명시 | 0.80 | 실패 영향/조건 |
| `contradicts` | 결정적으로 정렬한 양방향 충돌 | decision/document↔decision/document | 명시/추론 | 0.85 | 양쪽 근거와 충돌 설명 |

`same_as`, `related_to`, `contradicts`는 의미상 양방향이지만 저장 ID의 결정성을 위해 canonical ID 사전순으로 source/target을 정렬한다.

## Confidence와 evidence

- 구조 관계: `0.95~1.00`
- 원문에 동사가 명시된 관계: `0.85~1.00`
- 제한 규칙 추론: `0.75~0.90`
- Codex 후보: `0.70~0.95`, 서버 검증 전에는 영속 사실 관계가 아니다.
- `0.70` 미만은 저장하지 않고 분석 후보로만 남긴다.

모든 의미 관계는 `blockId`, 설명, commit 고정 `sourceUrl`을 최소 1개 가진다. 추론 관계는 동일 block의 명시 표현 또는 독립 근거 2개가 필요하다. stale document hash, 존재하지 않는 block, 허용되지 않은 source/target 타입은 저장 전에 거부한다.

## Alias와 병합 금지

확인된 alias 정본은 `app/lib/graph/entity-aliases.json`에 둔다. alias는 타입과 범위가 일치할 때만 적용한다.

- 통합 가능: `Codex SDK`, `공식 Codex SDK`, `@openai/codex-sdk` → `OpenAI Codex SDK`
- 통합 가능: 명령 문맥의 `gh` → `GitHub CLI`
- 통합 금지: 단독 `Codex`, 단독 `OpenAI`, 단독 `GitHub`
- 통합 금지: 서로 다른 문서의 `구현 태스크`, `자체 테스트`, `QA 관점`, `목표`
- 통합 금지: 같은 라벨이지만 다른 저장소·문서에 속한 Phase/Task/section

## Gold Graph 승인 기준

- 40~80개 노드이며 프로젝트·컴포넌트·기능·workflow·API·storage·technology·decision·risk·test가 함께 존재한다.
- 모든 노드와 관계가 D1 block ID 및 GitHub line evidence를 가진다.
- 구조 관계만으로 연결하지 않고 실제 pipeline, 구현, 사용, 호출, 검증, 위험 완화 관계가 보인다.
- 반복 템플릿 heading이 공용 허브가 되지 않는다.
- 현재 별자리·성운·궤도 GUI에서 핵심 커뮤니티와 브리지 노드를 설명할 수 있으며 최대 밀도 성능 fixture와 구분된다.
- Gold fixture는 읽기 전용이고 현재 D1·파서·영속 관계를 변경하지 않는다.

## Phase 4 전 승인 게이트

Gold Graph의 노드 제거·병합·추가, 관계 방향과 표현을 사용자와 검토한 뒤 이 문서와 fixture를 같은 버전으로 고정한다. 승인 전에는 Phase 4 규칙 추출기와 전체 853개 문서 관계를 재처리하지 않는다.
