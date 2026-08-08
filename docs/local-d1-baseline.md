# 로컬 D1 기준선·백업·복구

작성 일시: `2026-08-07 22:15 KST`

현재 앱은 Cloudflare 원격 DB가 아니라 `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`의 로컬 D1 호환 SQLite 정본을 사용한다. 정본 파일명은 기기별 object ID이므로 하드코딩하지 않고 `scripts/lib/local-d1.mjs`로 탐색한다.

## 읽기 전용 기준선 감사

```bash
npm run db:baseline
```

감사 범위:

- 문서·근거 블록·엔티티·mention·관계·작업 수량
- parser version, 문서 출처, 관계 origin·type, 보강 상태 분포
- 문서·엔티티가 없는 block·mention·relation
- 중복 관계 그룹과 남은 stage row
- SQLite `PRAGMA integrity_check`
- 결정적 data fingerprint

## 검증된 backup과 복구 점검

```bash
npm run db:baseline -- --backup --restore-check
```

처리 순서:

1. 현재 정본을 읽기 전용 감사한다.
2. WAL checkpoint 후 SQLite `VACUUM INTO`로 일관된 backup을 만든다.
3. backup을 다시 감사해 원본 data fingerprint와 비교한다.
4. backup SHA-256과 검증 결과를 `.wrangler/reports/d1-baseline-*.json`에 기록한다.
5. `--restore-check` 사용 시 임시 디렉터리에 복사한 DB를 다시 열어 무결성과 fingerprint를 확인한 뒤 삭제한다.

`.wrangler/`는 Git에서 제외되며 backup과 receipt에는 비공개 저장소 원문·메타데이터가 포함될 수 있으므로 외부에 업로드하지 않는다.

## 특정 DB 확인

```bash
npm run db:baseline -- --db=/absolute/path/to/database.sqlite
npm run graph:audit -- --db=/absolute/path/to/backup.sqlite
```

지정 경로는 실제 `.sqlite` 파일이어야 한다. 존재하지 않는 경로, 디렉터리, `metadata.sqlite`, 다른 확장자는 거부한다.

## 2026-08-07 Phase 1 backup 검증 영수증

- 문서 854 · 근거 블록 148,666 · mention 99,401
- 고유 엔티티 89,677 · 규칙 관계 94,494 · Codex 관계 1
- orphan 0 · 중복 관계 0 · stage row 0 · integrity `ok`
- data fingerprint: `d79a325ef5fb12dcad7592a86c5d48033a621084e903cb35556a0c33ef367bfd`
- backup bytes: `655,224,832`
- backup SHA-256: `b50cc3b7392a024fa02a1a479fe056358cd32ba261adb57de0057d15bec86a76`
- 임시 복구 DB와 원본 fingerprint 일치
- 복구 DB에서 corpus 500노드·2,000선, overview 130노드·176선, repository·Gold·max snapshot 조회 성공

이 영수증은 Phase 1 시점의 854문서 backup 기록이므로 그대로 보존한다.

## 2026-08-08 Phase 2 완료 후 현재 정본

- 임시 `atlas-md-ingestion-smoke-20260807.md`와 Phase 2 E2E 문서를 삭제했다.
- 문서 853 · 근거 블록 148,655 · mention 99,393 · 고유 엔티티 89,669
- 규칙 관계 94,487 · Codex 관계 1 · 전체 관계 94,488
- orphan 0 · 중복 관계 0 · stage row 0 · integrity `ok`
- data fingerprint: `fb0456967b27077f6bb52a30d941c5dd97883d014d0748d4fdb2d3629ed9675d`
