# Gold Graph 시각 QA — 2026-08-06

> **문서 역할:** 이 문서는 그래프 시각 회귀 기준이며 OAuth 런타임 변경과 독립적으로 유지한다. 현재 인증·실행 방향은 [current-oauth-runtime.md](./current-oauth-runtime.md)를 따른다.

최근 캡처: [현재 Gold Graph 화면](./screenshots/05-gold-graph-min.png) · 전체 화면 목록: [스크린샷 카탈로그](./screenshots/README.md)

검증 시각: `2026-08-06 20:43 KST`
검증 URL: `http://localhost:3000/?showcase=gold&view=constellation`

## 검증 대상

- 온톨로지 v1 Gold Graph fixture: 68노드·101관계
- 현재 Three.js 발광 GUI의 별자리·성운·궤도 보기
- Gold Graph 상태 라벨과 읽기 전용 데이터 메뉴
- 노드 상세의 D1 block·commit 고정 GitHub 원문 근거
- 현재 데이터에서 Gold Graph로 이동한 뒤 기존 보기·선택 노드 복원
- Gold Graph 직접 링크에서 현재 데이터로 돌아올 때 fixture 전용 선택 상태 제거

## 화면 검증 결과

| 항목 | 실제 확인 결과 | 판정 |
|---|---|---|
| 별자리 | `별자리 · GOLD SAMPLE 68N · 브라이트`, 68노드·101관계와 핵심 라벨을 발광 그래프로 표시 | 통과 |
| 성운 | `성운 · GOLD SAMPLE 68N · 브라이트`, 원형 소프트 글로우 배경 입자와 관계 그래프를 함께 표시 | 통과 |
| 궤도 | `궤도 · GOLD SAMPLE 68N · 브라이트`, 선택 노드를 중심으로 직접·확장 관계를 궤도로 표시 | 통과 |
| 상태 식별 | 좌측 eyebrow `ONTOLOGY GOLD SAMPLE`, indicator `GOLD SAMPLE`, 하단 `EVIDENCE GOLD SAMPLE` 표시 | 통과 |
| 데이터 메뉴 | 현재 지식 데이터·온톨로지 Gold Graph·최대 밀도 쇼케이스를 분리하고 Gold를 읽기 전용으로 설명 | 통과 |
| 근거 상세 | `AI Systems Atlas` 노드에서 repository, `README.md`, commit, GitHub line 링크와 연결 관계 13개 확인 | 통과 |

## 상태 복원 회귀 검증

### 현재 → Gold Graph → 현재

1. 현재 overview에서 `Python` 노드를 선택한 궤도 상태로 진입했다.
2. URL은 `?view=orbit&scope=overview&node=technology%3A4dwo7r`였다.
3. 데이터 메뉴에서 Gold Graph를 선택하면 `?view=constellation&scope=overview&showcase=gold`와 GOLD 상태로 전환됐다.
4. 현재 지식 데이터로 복귀하면 아래 상태가 그대로 복원됐다.
   - URL: `?view=orbit&scope=overview&node=technology%3A4dwo7r`
   - 보기: 궤도
   - 선택 노드: `Python`
   - 상태: `궤도 · MAP 111R · 브라이트`

판정: 통과

### Gold Graph 직접 링크 → 현재

1. `?showcase=gold&view=orbit&node=gold:project:memory-node-graph` 직접 링크로 진입했다.
2. 현재 지식 데이터로 복귀할 때 Gold fixture 전용 node와 궤도 상태를 제거했다.
3. 로딩 완료 후 아래 안전한 기본 상태를 확인했다.
   - URL: `?view=constellation&scope=overview`
   - 선택 노드: 없음
   - 상태: `별자리 · MAP 111R · 브라이트`

판정: 통과

## 발견 이슈와 수정

1. Gold Graph에서도 좌측과 하단 상태가 `DEMO`로 표시되던 문제
   - `app/knowledge-graph.tsx`에서 Gold 전용 `ONTOLOGY GOLD`, `GOLD`, `EVIDENCE GOLD GRAPH` 라벨로 분리했다.
2. Gold 궤도 직접 링크에서 현재 데이터로 돌아오면 `gold:*` node와 궤도 보기가 남던 문제
   - `app/lib/graph/scope-navigation.ts`에 `pageUrlForCurrentGraph`를 추가했다.
   - 저장된 현재 상태가 없는 presentation deep link는 선택 node를 제거하고 별자리로 복귀한다.
   - 현재 화면에서 presentation을 열었으면 저장한 보기·선택·필터 상태를 복원한다.
3. 회귀 방지
   - `tests/graph-scope-navigation.test.mjs`에 Gold·최대 밀도 직접 링크 복귀 테스트를 추가했다.
4. 68노드·101관계가 전체 853개 문서 그래프로 오해될 수 있던 문제
   - 제목, 상태 표시, 데이터 메뉴, 하단 설명과 API message에 `대표 문서 3개 검토 표본`, `전체 코퍼스 아님`을 명시했다.

## 자동 검증

- `npm test`: 110개 통과, 실패 0개
- `npx tsc --noEmit`: 통과
- `npm run lint`: 통과
- `git diff --check`: 통과

## 데이터 안전성

- Gold Graph는 JSON 기반 읽기 전용 fixture다.
- 이번 시각 QA와 상태 복귀 수정은 D1, Markdown parser, 실제 저장 관계를 변경하지 않는다.
- D1 기준선은 documents 853, blocks 148,655, entities 84,665, relations 85,662, enrichment jobs 0을 유지한다.

## 사용자 게이트

Phase 3의 구현·자동 검증·브라우저 QA는 완료했다. 온톨로지와 Gold Graph의 구조·시각 결과를 사용자가 승인한 뒤에만 Phase 4 규칙 기반 관계 추출을 시작한다.
