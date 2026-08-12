# AI Systems Atlas 스크린샷 카탈로그

촬영 일시: `2026-08-12 KST`

현재 `main` 로컬 실행 화면과 로컬 D1 데이터를 README에 표시하기 위한 스크린샷 모음이다.

## 촬영 기준

- 앱: `http://localhost:3000`
- 기본 viewport: `825 × 905`
- 데이터: 853문서 · 89,669 고유 엔티티 · 94,576 저장 관계
- GitHub discovery: 116 저장소 · 공개 80 · 비공개 36
- corpus 화면: 500노드 · 1,539 실제 관계 · 400 비저장 화면 연결
- 그래프 6종 발광값: `기본` 프리셋
- 그래프 하단 메뉴: Phase 2~5 관계 표시·화면 맞춤·노드 크기 제어 포함
- 캡처는 브라우저 viewport 기준이며 이미지 보정이나 합성은 하지 않았다.
- 대시보드는 내부 scroll container의 주요 구역을 나누어 캡처했다.
- 기존 `-min` 파일명은 README 링크 안정성을 위해 유지했다.

## 그래프 화면

| 파일 | URL 상태 | 내용 |
|---|---|---|
| `01-overview-orbit-detail-min.png` | `?scope=overview&view=orbit&node=repository:github:1322252398` | 저장소 overview 궤도·노드 상세·원문 근거 |
| `02-corpus-constellation-min.png` | `?scope=corpus&view=constellation` | 전체 D1 관계 중심 별자리 |
| `03-corpus-nebula-min.png` | `?scope=corpus&view=nebula` | 전체 D1 커뮤니티 성운 |
| `04-repository-constellation-min.png` | `?scope=repository&repositoryId=1322252398&view=constellation` | `memory_node_graph` 저장소 상세 |
| `05-gold-graph-min.png` | `?showcase=gold&view=constellation` | 68노드·101관계 Gold Graph |
| `06-max-density-showcase-min.png` | `?showcase=max&view=constellation` | 500노드·2,000관계 최대 밀도 fixture |

## 대시보드 화면

| 파일 | scroll 위치 | 내용 |
|---|---:|---|
| `07-dashboard-overview.png` | 0 | 문서·노드·관계 통계와 저장소 선택 |
| `09-dashboard-repositories.png` | 1,100 | 저장소별 그래프 반영 상태 |
| `10-dashboard-target-files.png` | 1,750 | README·dev-plan 대상 파일 |
| `11-dashboard-document-library.png` | 2,270 | Markdown 문서 라이브러리 |
| `12-dashboard-indexing-status.png` | 72,270 | 인덱싱·Codex 보강 작업 상태 |

## README 반영 원칙

- 대표 이미지는 `02-corpus-constellation-min.png`을 사용한다.
- 갤러리는 그래프 보기, 검토 fixture, 대시보드 운영 흐름 순서로 배치한다.
- 통합 Codex·GitHub OAuth 상태와 현재 작업 상태가 함께 보이는 대시보드만 사용한다.
- 데이터 수량, 기본 발광 프리셋, 하단 제어판, dashboard section 구조가 바뀌면 해당 화면을 재촬영한다.

## 관련 문서

- [프로젝트 README](../../README.md)
- [현재 OAuth 런타임 방향](../current-oauth-runtime.md)
- [Gold Graph 시각 QA](../gold-graph-visual-qa-20260806.md)
- [최신 구현 계획](../../dev-plan/implement_20260807_220621.md)
