# Vercel 공개 정적 배포

작성일: `2026-08-10 KST`

이 문서는 Cloudflare D1, SQLite, OAuth, API Key, Vercel Function 없이 AI Systems Atlas의 공개 읽기 전용 그래프를 Vercel에 배포하고 갱신·복구하는 절차의 정본이다.

## 배포 경계

```mermaid
flowchart LR
  M["로컬 Markdown"] --> D["로컬 Miniflare D1"]
  D --> E["공개 snapshot export"]
  E --> V["schema · SHA-256 · privacy 검증"]
  V --> G["GitHub main"]
  G --> B["Vercel Vite static build"]
  B --> C["Vercel CDN 정적 asset"]
  C --> W["브라우저 읽기 전용 그래프"]
```

- 원본 D1과 OAuth는 **snapshot을 만드는 로컬 승인 환경**에만 존재한다.
- Vercel은 `public/atlas/*.json`을 정적 파일로 제공한다.
- 공개 브라우저는 `/atlas/atlas-graph-snapshot.json`과 manifest만 읽으며 `/api/*`를 호출하지 않는다.
- 문서 업로드·삭제·재색인·GitHub Apply·Codex job은 공개 배포에 포함하지 않는다.
- Vercel 환경 변수, DB 연결, Function은 모두 `0`개가 정상 상태다.

## 공개 데이터 구분

| 데이터 | 용도 | 수량 | 사실성 |
|---|---|---:|---|
| Public Corpus | 공개 Markdown에서 만든 실제 관계 투영 | 500노드 · 1,372 실제 관계 + 400 display 선 | 실제 관계와 시각선 분리 |
| Gold Graph | 온톨로지 품질 검토 표본 | 68노드 · 101관계 | 전체 corpus 아님 |
| Max Density | 렌더링·시각 성능 데모 | 500노드 · 2,000선 | 합성 fixture |

Public Corpus snapshot SHA-256:

```text
8fcc13b245c5e0abe0820129c550fdcb133217151303ca9535122b011dd264d2
```

Gold Graph snapshot SHA-256:

```text
9b41847f7938dc03934753776af9cf297294997d826c4c73c0c914ba2ed2b336
```

## 다른 PC에서 빌드

원본 D1, GitHub/Codex OAuth, `.env`가 필요하지 않다.

```bash
git clone https://github.com/coreline-ai/memory_node_graph.git
cd memory_node_graph
npm ci
npm run graph:verify-public
npm run build:vercel
npm run preview:vercel
```

기본 preview 주소는 `http://localhost:4173/`이다. `/dashboard`와 임의 직접 경로도 공개 그래프로 안전하게 연결된다.

## Vercel 프로젝트 설정

### GitHub 연동

1. Vercel에서 `coreline-ai/memory_node_graph` 저장소를 Import한다.
2. Production branch를 `main`으로 선택한다.
3. Root Directory는 저장소 루트로 둔다.
4. Framework Preset은 `Other` 또는 저장소의 `vercel.json` 자동 설정을 사용한다.
5. 환경 변수는 추가하지 않는다.

`vercel.json`의 정본 값:

| 항목 | 값 |
|---|---|
| Install Command | `npm ci` |
| Build Command | `npm run build:vercel` |
| Output Directory | `dist-vercel` |
| Runtime Functions | 없음 |

PR/비-main branch push는 Preview, `main` push는 Production으로 운영한다. 배포 전에 GitHub Actions의 `Public Atlas static checks`가 성공해야 한다.

### CLI 배포

Vercel 로그인이 이미 되어 있는 환경에서는 다음을 사용할 수 있다.

```bash
# 최초 1회 프로젝트 연결 또는 Preview
npx vercel@latest --yes

# Production
npx vercel@latest --prod --yes
```

CLI가 로그인 또는 scope 선택을 요구하면 브라우저 인증 후 다시 실행한다. 인증이 없다는 이유로 token을 저장소나 `.env`에 추가하지 않는다.

현재 실제 배포는 승인 범위를 좁히기 위해 `dist-vercel/`의 검증된 정적 파일 16개와 정적 라우팅용 `vercel.json` 1개만 별도 스테이징하여 수행했다. Vercel dry-run은 입력을 **17개 파일·2.7MB**로 확인했으며, 저장소의 `.wrangler`, SQLite, OAuth, 환경 변수와 서버 소스는 업로드하지 않았다.

## 빌드 검증

```bash
npm run graph:verify-public-sources
npm run graph:verify-public
npm run graph:verify-public-fixtures
npm run build:vercel
npm run lint
npx tsc --noEmit
npm test
npm audit --omit=dev --audit-level=high
git diff --check
```

`scripts/verify-vercel-static-output.mjs`는 다음을 발견하면 빌드를 실패시킨다.

- snapshot 누락, schema/SHA-256/수량 불일치
- Vercel Function, `api`, `server`, `.wrangler` 경로
- SQLite/DB 파일, source map, private key, token, 로컬 절대경로
- Cloudflare runtime, D1 client, Drizzle DB client, Codex SDK, 내부 `/api/*` 호출이 포함된 브라우저 bundle

GitHub Actions는 커밋된 snapshot을 **검증만** 한다. Actions에서 원본 D1 snapshot을 생성하거나 수정하지 않는다. production dependency에 대해 `npm audit --omit=dev --audit-level=high`도 실행한다.

## 브라우저 보안 헤더

`vercel.json`과 `npm run preview:vercel`은 동일한 공개 정적 보안 정책을 사용한다.

- `script-src 'self'`; inline script와 `unsafe-eval`을 허용하지 않음
- `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`
- Three.js 화면에 필요한 `img-src 'self' data: blob:`과 React inline style을 위한 `style-src 'self' 'unsafe-inline'`만 허용
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- camera·microphone·geolocation 권한 비활성화

로컬 static preview에서는 응답 헤더와 320px·390px·desktop 브라우저의 CSP violation 0건을 확인한다. Vercel Production 응답 검증은 보안 헤더가 포함된 commit이 실제 배포된 뒤 수행하며, 소스 반영만으로 실배포 완료를 보고하지 않는다.

## GitHub Check와 Production Gate

`Public Atlas static checks`는 PR 및 `main` push마다 live public source visibility, snapshot, lint/type, 정적 산출물과 production dependency High 감사를 수행한다. 다만 `2026-08-15` 읽기 전용 확인 기준으로 `main` branch protection과 repository ruleset은 설정되어 있지 않다. 또한 Vercel Git Integration은 GitHub status check 성공을 기다리는 강제 직렬 gate임을 저장소 코드만으로 보장하지 않는다.

현재 운영 규칙은 다음과 같다.

1. 일반 변경은 PR에서 `Public Atlas static checks` 성공 후 `main`에 반영한다.
2. public source가 private/deleted로 바뀌었다는 실패가 발생하면 새 Production을 승인하지 않는다.
3. 이미 자동 배포가 시작됐다면 마지막 정상 deployment를 즉시 Promote하고, 해당 source를 제외해 snapshot을 재생성한 수정 commit을 배포한다.
4. 완전한 강제 gate가 필요하면 별도 승인 하에 main branch required check와 Vercel의 배포 승인 정책을 설정한다. 저장소 secret이나 PAT를 코드·환경 파일에 추가하는 우회는 사용하지 않는다.

### 공개 철회 절차

```bash
# 1. live public source drift 확인 — 실패 결과를 무시하지 않는다.
npm run graph:verify-public-sources

# 2. private/deleted source를 로컬 D1 공개 대상과 source 정책에서 제외
# 3. 공개 artifact를 새로 생성·검증
npm run graph:prepare-public
npm run build:vercel

# 4. diff에서 철회 대상의 노드·관계가 사라졌는지 검토 후 새 commit 배포
git diff -- public/atlas config/public-graph-sources.json
```

## Markdown 추가 후 공개 데이터 갱신

```bash
# 1. 승인된 Markdown을 로컬 앱/D1에 반영
# 2. 쓰기 전후 기준선과 관계 무결성 확인
npm run db:baseline
npm run graph:audit

# 3. 공개 source 정책·D1 기준선·export·검증
npm run graph:prepare-public

# 4. 공개 diff와 정적 build 검토
git diff -- public/atlas config/public-graph-sources.json
npm run build:vercel

# 5. 승인된 변경만 commit/push
git add public/atlas config/public-graph-sources.json
git commit -m "data: refresh public graph snapshot"
git push github main
```

`graph:export-public` 결과가 `mode: unchanged`이면 D1 fingerprint와 공개 source 정책이 동일하므로 데이터 파일 커밋과 불필요한 재배포를 생략할 수 있다. 문서를 추가·삭제하면 provenance 안전성을 다시 고정하기 위해 revision과 checksum이 갱신될 수 있으며, 최종 D1 상태를 원복한 뒤 다시 export하면 기존 checksum으로 복구된다.

## 배포 후 QA

- 로그인 없이 Public Corpus가 `500 노드 / 1,372 실제 관계 + 400 display 선`으로 표시된다.
- 공개 원본 `53,377노드 / 56,406관계`와 화면 투영이 구분된다.
- Gold는 `68/101`, Max Density는 `500/2,000 DEMO`로 표시된다.
- 검색·필터·노드 선택·별자리·성운·궤도·pan·zoom·발광·커스텀이 동작한다.
- 360px, 768px, 1280px에서 페이지 가로 스크롤이 없고 커스텀 메뉴와 데이터 메뉴가 화면 안에 있다.
- 네트워크에는 정적 HTML/JS/CSS/이미지와 `/atlas/*`만 있고 `/api/*`, OAuth, D1, DB 요청이 없다.
- 브라우저 콘솔에 uncaught error가 없다.

## Rollback

### Git 기준 복구

1. Vercel에서 정상 동작하던 Production deployment가 가리키는 Git commit을 확인한다.
2. 현재 `main`을 강제 reset하지 않는다.
3. 문제 commit을 `git revert <commit>`으로 되돌리는 새 commit을 만든다.
4. 검증 명령을 모두 통과한 뒤 `main`에 push한다.
5. 새 Production이 이전 snapshot SHA-256과 GUI를 복구했는지 확인한다.

### Vercel 즉시 복구

Vercel Deployments에서 직전 정상 Production을 선택해 **Promote to Production**한다. 이후 Git 정본도 반드시 revert commit으로 일치시킨다.

## 문제 해결

| 증상 | 확인·조치 |
|---|---|
| snapshot SHA 오류 | JSON만 수정하지 말고 로컬 승인 환경에서 `graph:prepare-public`을 다시 실행한다. |
| Gold drift 오류 | `npm run graph:export-public-fixtures` 후 diff를 검토한다. CI에서는 생성하지 않는다. |
| 정적 화면이 ERROR | `/atlas/atlas-graph-snapshot.json`과 manifest 응답·cache를 확인한다. fixture fallback은 사용하지 않는다. |
| `/dashboard` 직접 접근 404 | 프로젝트가 저장소 루트의 `vercel.json`을 사용하고 있는지 확인한다. |
| Function이 생성됨 | Vercel Build Command와 Output Directory가 각각 `build:vercel`, `dist-vercel`인지 확인한다. |
| 로컬 build와 결과가 다름 | Node `22.14.0+`, lockfile 기반 `npm ci`, 환경 변수 없음 조건을 맞춘다. |

## 현재 배포 기록

| 항목 | 현재 기록 |
|---|---|
| 기능 구현 commit | `91eb9a384dadefa779ad33547137b20a04a48fba` |
| 기능·snapshot 검증 기준 commit | `35cc2d8be8868a7a845b794c3cd24f7792041bf6` |
| GitHub main push | 완료 |
| GitHub Actions | [Public Atlas static checks · success](https://github.com/coreline-ai/memory_node_graph/actions/runs/31639959848) |
| Clean clone | `npm ci && npm run graph:verify-public && npm run build:vercel` 성공 |
| Vercel CLI 인증 | `hwanchoiganda-7455` 계정 확인 |
| Vercel project | `ai-systems-atlas` · `prj_Jwh8gVgPf63GFUUukVEwwgjqp9qe` |
| 기능·snapshot 검증 deployment | [https://ai-systems-atlas.vercel.app](https://ai-systems-atlas.vercel.app) · `dpl_3DrTGRpkqN1EwAVVFoF3dDAChjCa` · `READY` |
| Preview | [preview URL](https://ai-systems-atlas-8tb620h0y-corelines-projects-277c5e1c.vercel.app) · `dpl_DGsb1gDCTJ1A2oaF5xrxebEggmby` · `READY` · 최종 정책은 SSO 보호 유지 |
| GitHub 자동 배포 | `2026-08-13` `main` push → Production 생성 · deployment metadata의 ref/SHA 일치 검증 완료 |

문서-only 후속 commit도 `main` 자동 배포를 새로 만들 수 있으므로 최신 deployment ID는 고정 문서값으로 판단하지 않고 `vercel inspect ai-systems-atlas.vercel.app`으로 확인한다. 위 ID는 기능 코드와 공개 snapshot 자체를 검증한 release 증적이다.

### 2026-08-13 최종 Production·복구 QA

- Production은 로그인 없이 Public Corpus `500노드 / 1,372 실제 관계 + 400 display 선`을 표시했다.
- Gold `68/101`, Max Density `500/2,000 DEMO`, 별자리·성운·궤도, 검색·노드 선택, 렌즈 필터, pan·zoom, 초신성·커스텀 밝기를 실제 브라우저에서 확인했다.
- 필터 적용 후 `구도 맞춤`이 표시 중인 212노드와 545관계를 UI 안전 영역에 맞추는 상태 메시지를 확인했다.
- `390×844` 모바일에서 `documentElement`와 `body`의 `scrollWidth`가 모두 `390`이었고, canvas·필터·하단 제어가 정상 로드됐다.
- `/dashboard`는 `/`로 안전하게 이동했고 `/knowledge/demo` 직접 접근은 SPA fallback으로 정상 로드됐다.
- 관찰된 네트워크 자산은 정적 JS/CSS/favicon과 `/atlas/atlas-graph-snapshot.json`, `/atlas/atlas-graph-manifest.json`뿐이며 `/api/*`, OAuth, D1, DB 요청은 없었다.
- 브라우저 warning/error 로그는 `0`건이었다.
- Vercel inspect에서 Production과 Preview 모두 `READY`, `middleware: []`였고 동일한 정적 rewrite/header 설정을 사용했다.
- GitHub `main` commit `35cc2d8` push가 CLI 업로드 없이 Production deployment를 생성했고 Vercel metadata의 `githubCommitRef=main`, `githubCommitSha=35cc2d8...`를 확인했다.
- 직전 정상 deployment `91eb9a3`로 일시 rollback하여 공개 corpus `500/1,770`을 확인한 뒤, 승인된 최신 deployment `35cc2d8`로 복구해 공개 corpus `500/1,772`와 alias를 재확인했다.

Preview deployment 자체는 생성됐지만 팀의 기본 `ssoProtection: all_except_custom_domains`를 유지한다. 사용자는 `2026-08-13` Production 기준으로 프로젝트 종료를 선택했으며, 현재와 향후 Preview를 비로그인 공개하는 변경은 최종 범위에서 제외했다. Production, GitHub 자동 배포, rollback·원상 복구는 모두 검증 완료 상태다.
