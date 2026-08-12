# 공개 그래프 스냅샷

작성일: `2026-08-10 KST`

이 문서는 원본 로컬 D1을 Git에 포함하지 않고도 다른 PC가 GitHub clone만으로 공개 그래프를 검증·배포할 수 있게 만든 데이터 artifact의 정본이다.

## 포함 파일

| 파일 | 역할 |
|---|---|
| `config/public-graph-sources.json` | GitHub OAuth로 `PUBLIC` 상태를 확인한 저장소 allowlist |
| `public/atlas/atlas-graph-snapshot.json` | 실제 D1 공개 전용 500노드·2,000선 GraphSnapshot |
| `public/atlas/atlas-graph-manifest.json` | source fingerprint·공개 정책 hash·수량·privacy 계약 |
| `public/atlas/atlas-graph-snapshot.sha256` | snapshot 파일 SHA-256 |
| `public/atlas/atlas-gold-snapshot.json` | 내부 provenance를 제거한 68노드·101관계 Gold 검토 표본 |
| `public/atlas/atlas-gold-snapshot.sha256` | Gold snapshot 파일 SHA-256 |

## 현재 정합성 기준선

| 항목 | 수량 |
|---|---:|
| GitHub에서 확인한 공개 저장소 | 81 |
| 현재 D1에 문서가 있는 공개 저장소 | 78 |
| 공개 완료 Markdown | 519 |
| 공개 전용 corpus node | 53,377 |
| 공개 전용 저장 관계 | 56,406 |
| 혼합 provenance로 제외한 node | 94 |
| 공개 화면 투영 node | 500 |
| 공개 화면 실제 관계 | 1,372 |
| 비저장 display 선 | 400 |
| 전체 화면 선 | 1,772 |

현재 snapshot SHA-256:

```text
8fcc13b245c5e0abe0820129c550fdcb133217151303ca9535122b011dd264d2
```

Gold snapshot SHA-256:

```text
9b41847f7938dc03934753776af9cf297294997d826c4c73c0c914ba2ed2b336
```

원본 D1 기준 fingerprint:

```text
fdaa8da576cd961933d7c18c5047a77bab844f6a4064c1f076af3aed8e9af53f
```

## 공개 안전 정책

- `gh repo list ... --visibility public` 결과와 명시 allowlist가 일치해야 export할 수 있다.
- 공개 문서와 비공개·manual 문서에 함께 등장한 node는 혼합 provenance로 제외한다.
- 내부 node ID는 deterministic SHA-256 공개 ID로 변환한다.
- relation evidence, block ID, 문서 ID, 저장소 내부 ID, source path는 JSON에서 제거한다.
- OAuth, D1 파일, job/runtime 상태는 포함하지 않는다.
- 토큰·private key·로컬 절대경로 패턴이 발견되면 검증을 실패시킨다.
- 실제 저장 관계와 화면용 display 선을 별도 수량과 `layer`/`origin`으로 유지한다.

## 다른 PC에서 검증

다른 PC에는 원본 D1이나 GitHub/Codex OAuth가 없어도 된다.

```bash
git clone https://github.com/coreline-ai/memory_node_graph.git
cd memory_node_graph
npm ci
npm run graph:verify-public
```

검증은 schema, SHA-256, node/edge 예산, endpoint, 중복, 금지 필드, 민감정보 패턴을 확인한다.

## Vercel 공개 정적 GUI 로컬 확인

공개 모드는 D1 API, revision polling, 최근 문서 API, 전체 corpus 검색 API를 호출하지 않는다. 포함된 500개 노드만 브라우저에서 검색·필터링한다.

```bash
npm run build:vercel
npm run preview:vercel
```

화면에는 `PUBLIC MAP`, 공개 원본 수량, 실제 관계와 display 선 수가 표시된다. 문서 관리·저장소/문서 drill-down은 숨긴다. Gold Graph는 별도 공개 checksum snapshot을 읽고, 최대 밀도 fixture는 브라우저에서 읽기 전용으로 생성한다.

`build:vercel`은 공개 snapshot과 Gold artifact가 추적된 정본과 일치하는지 검사한 뒤 `dist-vercel/`을 생성한다. CI와 Vercel build에서는 원본 D1 snapshot을 새로 생성하거나 파일을 수정하지 않는다.

## 원본 환경에서 갱신

갱신에는 로컬 D1과 `gh` OAuth가 필요하다. OpenAI API Key나 GitHub PAT 환경 변수는 사용하지 않는다.

```bash
# GitHub 공개 여부 drift 확인 + D1 baseline + export + artifact 검증
npm run graph:prepare-public

# 공개 저장소 목록이 실제 GitHub 상태와 달라졌을 때만 검토 후 갱신
npm run graph:refresh-public-sources
npm run graph:prepare-public
```

`graph:export-public`은 read-only D1 조회만 수행한다. 동일 fingerprint와 source 정책에서는 파일을 다시 쓰지 않고 `mode: unchanged`를 반환한다.

## Markdown 추가 후 배포 데이터 갱신

```text
Markdown 추가·승인
→ 로컬 D1 저장
→ db:baseline / graph:audit
→ 공개 저장소 상태 확인
→ graph:export-public
→ graph:verify-public
→ snapshot diff 검토
→ GitHub commit/push
→ Vercel Git 배포
```

## 배포 경계와 현재 상태

- Vercel 전용 정적 Vite entry, `vercel.json`, 산출물 보안 verifier, secret 없는 GitHub Actions가 구현됐다.
- 다른 PC는 GitHub 파일만으로 공개 artifact를 검증하고 `dist-vercel/`을 만들 수 있다.
- Vercel 프로젝트에는 D1, SQLite, API Key, OAuth, 환경 변수, Function이 필요하지 않다.
- 실제 Preview/Production URL과 배포 결과는 [Vercel 공개 정적 배포](./vercel-static-deployment.md)의 배포 기록을 정본으로 한다. URL을 확인하기 전에는 외부 배포 완료로 간주하지 않는다.
