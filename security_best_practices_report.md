# AI Systems Atlas 보안 재검토·구현 보고서

- 최초 검토일: `2026-08-15 KST`
- 구현 재검증일: `2026-08-15 KST`
- 대상: `/Volumes/Eprojects/project_202608/node_wiki`
- 범위: 공개 Vercel 정적 앱, 로컬 vinext·D1·Codex/GitHub OAuth 통합 앱, build/CI 경계

## 1. 최종 요약

현재 프로젝트의 실제 배포 경계에 맞춰 기존 Finding을 다시 분류하고 필수 항목을 구현했다. 공개 Vercel은 Function·D1·OAuth가 없는 읽기 전용 정적 앱이고, 로컬 통합 앱만 Markdown 원본·D1·OAuth·변경 Route를 가진다. 따라서 공개 앱에 불필요한 로그인 서버를 추가하지 않고 다음 원칙을 적용했다.

1. 로컬 앱은 기본 `127.0.0.1` loopback으로만 실행한다.
2. 원격 접근은 명시적 `proxy` 모드와 신뢰 OAuth reverse proxy 뒤에서만 허용한다.
3. 브라우저 변경 요청은 Host·Origin·Fetch Metadata로 보호한다.
4. Codex는 OAuth에 필요한 최소 환경만 받고, 비밀 형식 출력은 저장 전에 격리한다.
5. 공개 앱은 검증된 정적 JSON만 배포하고 CSP·iframe 차단을 적용한다.

### 현재 상태

| 구분 | 상태 | 설명 |
|---|---|---|
| Critical | 0 | 확인된 직접 악용 경로 없음 |
| 필수 High | 완료 | H01·H02·H03 구현, production dependency High 0 |
| 필수 Medium/Low | 완료 | cross-site 변경, production test mode, 오류·origin 처리 완료 |
| 조건부 보류 | 2 | 원격 동적 서비스일 때 streaming multipart/rate limit, cookie CSRF token 필요 |
| 잔여 운영 위험 | 2 | dev toolchain advisory, GitHub/Vercel hard deployment gate 미설정 |
| 실배포 확인 대기 | 1 | CSP·frame header는 소스/local preview 완료, Production은 다음 배포 후 확인 필요 |

## 2. 실제 위협 경계

### 2.1 공개 Vercel 정적 앱

- `vercel.json:3-6`은 `dist-vercel`만 배포하고 Vercel Function을 만들지 않는다.
- `package.json:32-34`는 공개 snapshot·fixture·정적 output을 검증한다.
- `scripts/verify-vercel-static-output.mjs`는 API/server/DB/Codex SDK/source map/비밀 패턴을 차단한다.
- 공개 브라우저는 `public/atlas/*.json`만 읽으며 전체 D1·원문·OAuth 상태에 접근하지 않는다.

### 2.2 로컬 통합 앱

- `package.json:10-18`은 vinext, 로컬 D1, 통합 Codex/GitHub runtime을 함께 실행한다.
- `scripts/start-integrated-app.mjs:9-18,74-86`은 일회성 IPC secret을 생성하고 웹 서버를 `127.0.0.1`에 바인딩한다.
- Markdown 업로드·삭제·재처리와 full D1 read는 로컬 단일 사용자 기능이다.

### 2.3 인증 프록시 모드

- `app/lib/auth/write-access.ts:14-20`에서 `ATLAS_EXPOSURE_MODE=proxy`는 write 인증을 강제한다.
- `app/lib/auth/write-access.ts:40-45`에서 요청 origin이 `ATLAS_APP_ORIGIN`과 일치해야 한다.
- `app/lib/auth/write-access.ts:117-127`에서 identity 없는 full D1 read를 거부한다.
- 외부 사용자가 보낸 identity header를 앱이 자체 서명 검증하지는 않는다. 따라서 프록시가 해당 header를 제거한 뒤 검증된 identity만 주입하는 것이 필수 운영 계약이다.

## 3. Finding 처리 결과

### SEC-H01 — 외부 바인딩·변경 API fail-open

- **상태:** 완료
- `scripts/start-integrated-app.mjs:9-10,74-86`에서 dev·production 모두 `127.0.0.1`에 명시적으로 바인딩한다.
- `app/lib/auth/write-access.ts:40-45,95-109`에서 허용 Host, 변경 요청 검증, proxy 인증을 공용 guard로 적용한다.
- `tests/security-boundaries.test.mjs`가 모든 POST/PUT/PATCH/DELETE Route의 write/runtime guard 누락을 검사한다.

### SEC-H02 — private D1 read의 원격 노출

- **상태:** 완료(현재 경계 기준)
- loopback local 모드에서는 기존 단일 사용자 UX를 유지한다.
- proxy 모드에서는 graph, query, documents, search, revision, ingestion job read가 공용 `requireAtlasReadAccess`를 사용한다.
- 공개 읽기는 full D1 Route가 아니라 비식별 정적 JSON target으로 분리되어 있다.
- tenant별 DB row authorization은 다중 사용자 동적 서비스로 전환할 때만 추가한다.

### SEC-H03 — Codex 자식 환경 denylist

- **상태:** 완료
- `server/codex/codex-engine.ts:43-87`은 PATH, HOME/CODEX_HOME, temp, locale, 인증서 등 최소 allowlist만 전달한다.
- `GH_TOKEN`, `GITHUB_TOKEN`, 임의 `*_TOKEN`·`*_SECRET`, `DATABASE_URL`, `NODE_OPTIONS`, SSH agent는 전달하지 않는다.
- `server/codex/codex-engine.ts:70-107`은 알려진 token/private-key 패턴과 부모의 민감 환경 값이 출력에 포함됐는지 검사한다.
- 관계 보강은 `server/codex/codex-engine.ts:224-243`에서 read-only sandbox, network off, web search disabled, approval never와 출력 guard를 함께 사용한다. Graph RAG 답변에도 같은 guard를 적용한다.
- 최소 환경으로 `codex login status`가 `Logged in using ChatGPT`를 반환해 API Key 없는 OAuth 사용을 확인했다.

### SEC-H04 — 취약 의존성

- **상태:** production 완료, dev toolchain 잔여 위험 기록
- `package.json:45-47,65-71` 기준 Next `16.3.1`, React `19.2.8`, eslint-config-next `16.3.1`, Vite `8.2.1`, Wrangler `4.123.0`으로 갱신했다.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- `.github/workflows/public-atlas-check.yml:30-40`은 lockfile 설치 뒤 production dependency High 감사를 실행한다.
- 전체 audit에는 devDependency의 `vinext -> image-size` High 2와 `drizzle-kit -> esbuild` Moderate 4가 남는다. 현재 제시된 자동 해결은 vinext/drizzle-kit의 호환성 불명 downgrade이므로 `npm audit fix --force`를 사용하지 않았다.
- `image-size`는 신뢰된 build asset 경로의 dev toolchain이며 Markdown은 binary upload를 거부한다. 패치된 상위 릴리스가 나오면 별도 호환성 검증 후 갱신한다.

### SEC-M01 — multipart 선파싱 자원 사용

- **상태:** 현재 local 경계에 필요한 조기 차단 완료, 원격 서비스용 streaming 제한은 조건부 보류
- `app/api/documents/route.ts`는 `formData()` 전에 명백히 큰 `Content-Length`를 413으로 거부한다.
- local loopback 단일 사용자에서는 새 multipart 의존성 도입보다 현재 제한이 적합하다.
- 동적 앱을 원격 다중 사용자에게 공개할 때 reverse proxy body/part/concurrency 제한, streaming parser, 사용자/IP rate limit을 별도 Phase로 구현한다.

### SEC-M02 — cross-site 변경/CSRF

- **상태:** 현재 구조 완료, cookie CSRF token은 조건부
- `app/lib/auth/write-access.ts:57-87`에서 `Sec-Fetch-Site: cross-site`와 불일치 Origin을 거부한다.
- proxy identity가 있어도 cross-site 요청은 인증보다 먼저 403으로 차단한다.
- 향후 cookie session을 앱이 직접 소유하면 CSRF token과 `Secure`, `HttpOnly`, `SameSite` cookie 검증을 추가한다.

### SEC-M03 — CSP·clickjacking

- **상태:** 소스/local static preview 완료, Production 배포 확인 대기
- `vercel.json:45-67`은 `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`과 `X-Frame-Options: DENY`를 적용한다.
- script에는 `unsafe-inline`·`unsafe-eval`을 허용하지 않는다. React의 현재 inline style만 `style-src 'unsafe-inline'`로 허용한다.
- `vite.public.config.ts`의 local static preview에도 동일 정책을 적용했다.
- 320px·390px·desktop에서 canvas와 공개 JSON이 정상 로드되고 browser warning/error/CSP violation은 0건이었다.
- 현재 Production은 이 변경 전 deployment라 CSP/frame header가 아직 없다. 다음 commit·배포 후 실제 응답을 재확인해야 완료 증적이 된다.

### SEC-M05 — production test-mode 우회

- **상태:** 완료
- `scripts/start-integrated-app.mjs:4-8`과 `server/runtime/config.ts:13-19`은 production의 `ATLAS_TEST_MODE=true`를 시작 전에 거부한다.
- `app/lib/auth/runtime-access.ts:43-65`는 production에서 유효한 일회성 내부 IPC secret만 허용하며 test flag를 인증 bypass로 사용하지 않는다.

### SEC-L01 — 내부 오류 노출

- **상태:** 완료
- `app/lib/http/api-error.ts:3-45`은 token·private key·credential·로컬 경로를 redaction하고 client에는 고정 메시지, 코드, UUID request ID만 반환한다.
- graph/query/search/revision, enrichment, GitHub source 공용 catch에 적용했다.

### SEC-L02 — Host 기반 metadata origin

- **상태:** 완료
- `app/layout.tsx:5-29`는 유효한 `ATLAS_APP_ORIGIN`을 우선하고, 없으면 loopback Host만 허용하며 `x-forwarded-host`를 신뢰하지 않는다.

### SEC-L03 — GitHub 검증과 Vercel hard gate

- **상태:** CI 검증 강화 완료, 외부 설정 잔여 위험
- `.github/workflows/public-atlas-check.yml:3-40`은 PR/main에서 read-only GitHub token으로 live source visibility와 production dependency를 검증한다.
- `2026-08-15` GitHub API 읽기 확인 결과 `main` branch protection은 없고 repository ruleset도 0개였다.
- Vercel Git Integration이 GitHub check 성공을 기다리는 required gate라는 증거도 저장소에는 없다. 자동 배포 경쟁을 완전히 없애려면 외부 설정 변경이 필요하다.
- 현재는 실패한 source visibility check가 있으면 Production을 승인하지 않고 직전 정상 deployment를 Promote한 뒤 source 제외 snapshot을 재생성하는 운영 절차를 `docs/vercel-static-deployment.md`에 기록했다.
- branch protection 또는 Vercel 배포 승인 정책 변경은 push 흐름에 영향을 주므로 별도 사용자 승인 후 시행한다.

## 4. 확인된 방어

- Markdown은 AST 기반으로 파싱하며 raw HTML DOM sink를 사용하지 않는다.
- extension, 파일 크기, binary signature/control 문자, UTF-8을 검사한다.
- GitHub 명령은 shell 문자열이 아닌 검증된 인자 배열을 사용하고 blob SHA를 재검증한다.
- 검토한 D1 query는 parameter binding을 사용한다.
- 공개 snapshot은 provenance key 제거, local path 정리, ID pseudonymization, orphan/checksum/schema 검증을 수행한다.
- 정적 output verifier는 API/server/DB/Codex SDK/source map/token/private key/local path를 차단한다.

## 5. 검증 결과

| 검증 | 결과 |
|---|---|
| `npm test` | PASS — 229/229 |
| 보안 경계·Codex·Vercel targeted test | PASS — 14/14 |
| 공개 Vercel static build | PASS — 15 files, Function 0, API 0, DB client 0, source map 0 |
| local static CSP browser smoke | PASS — desktop·320px·390px, console warning/error 0 |
| local static response header | PASS — CSP, DENY, nosniff, referrer, permissions 확인 |
| `npm audit --omit=dev --audit-level=high` | PASS — 0 vulnerabilities |
| full `npm audit` | 잔여 6 — dev toolchain High 2, Moderate 4 |
| GitHub branch protection/ruleset | 미설정 — 외부 운영 위험으로 기록 |
| Codex OAuth 최소 환경 smoke | PASS — ChatGPT OAuth 로그인 유지 |
| local 통합 앱 smoke | PASS — `127.0.0.1:3000`, D1 corpus 500노드 응답, 작업 처리 0건 dry-run |

lint, typecheck, `build:vercel`, `git diff --check`도 모두 통과했다. public source live 검증은 삭제·비공개 전환 0건이며 새 공개 저장소 `coreline-ai/voice-tracker-find` 1건의 추가 drift만 보고했다. 이 저장소를 공개 corpus 정책에 추가하는 작업은 보안 수정 범위 밖이므로 자동 반영하지 않았다.

## 6. 조건부 후속 과제

다음은 현재 공개 정적 Vercel + 로컬 단일 사용자 구조에는 필요하지 않다. 로컬 통합 앱을 원격 다중 사용자 서비스로 실제 공개할 때 새 보안 계획으로 시작한다.

1. reverse proxy streaming multipart/body/part/concurrency 제한
2. cookie session CSRF token과 cookie 속성 검증
3. 사용자·tenant별 D1 row authorization
4. 사용자/IP별 rate limit·감사 로그
5. proxy identity attestation과 허용 사용자/역할 정책

## 7. 최종 판단

현재 구조에서 필요한 핵심 보안 보강은 코드에 반영됐다. 공개 Vercel에 OAuth·DB 서버를 새로 추가하거나 local read UX에 일괄 로그인을 강제하는 것은 오히려 프로젝트 목적에서 벗어난다. 남은 실질 작업은 변경 사항의 전체 회귀 통과와 다음 Vercel 배포 후 CSP/frame 응답 헤더 확인이다.
