# AI Systems Atlas 구현 계획

## Phase 1. 기반 계약

- [x] 문서 source identity를 고정한다.
- [ ] README와 dev-plan 프로필을 연결한다.
  - [x] 모든 구조 관계에 line evidence를 연결한다.

### 의존성

- TypeScript 컴파일과 Connector 검증이 필요하다.

### 위험

- OAuth 권한 경계가 무너지면 비공개 원문이 노출될 수 있다.

### 결정

- 원문 line URL을 모든 구조 관계의 근거로 유지한다.

### 완료 조건

- [ ] 전체 parser fixture가 통과한다.
