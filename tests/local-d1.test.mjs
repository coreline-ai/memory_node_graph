import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveLocalD1Database } from "../scripts/lib/local-d1.mjs";

test("로컬 D1 탐색은 기기별 object ID를 하드코딩하지 않고 모호한 상태를 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-local-d1-"));
  const directory = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  try {
    await mkdir(directory, { recursive: true });
    await assert.rejects(resolveLocalD1Database({ root }), /찾을 수 없습니다/);
    await writeFile(join(directory, "metadata.sqlite"), "metadata");
    await assert.rejects(resolveLocalD1Database({ root }), /찾을 수 없습니다/);
    const first = join(directory, "worker-object-a.sqlite");
    await writeFile(first, "database");
    assert.equal(await resolveLocalD1Database({ root }), first);
    const requested = join(root, "custom.sqlite");
    assert.equal(await resolveLocalD1Database({ requested }), resolve(requested));
    await writeFile(join(directory, "worker-object-b.sqlite"), "database");
    await assert.rejects(resolveLocalD1Database({ root }), /여러 개/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
