# Atlas Explicit Relations

## API와 저장

`POST /api/documents`는 `app/api/documents/route.ts`에서 documents 테이블에 저장합니다.

조회 작업은 `GET /api/documents`로 documents 테이블을 읽습니다.

SDK 연동은 `@openai/codex-sdk`에 의존합니다.

## 설치

설정 파일은 [app/config.ts](./app/config.ts)를 참고합니다.

상세 계획은 [Phase 계획](dev-plan/implement.md)을 참고합니다.

이 문서의 [API와 저장](#api와-저장)을 다시 확인합니다.

[외부 문서](https://example.com/docs)도 참고할 수 있습니다.

## 검증

```bash
npm test
npx tsc --noEmit
```

예시 payload의 `{"path":"/not-an-api"}`는 API 계약이 아닙니다.

```json
{"method":"POST","path":"/not-an-api","table":"sample"}
```
