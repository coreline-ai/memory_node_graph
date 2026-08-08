import assert from "node:assert/strict";
import test from "node:test";

import {
  assertD1AtomicBatchLimit,
  chunkD1Statements,
  D1_GRAPH_BATCH_STATEMENT_LIMIT,
} from "../.runtime-dist/app/lib/storage/d1-batch-policy.js";

test("D1 Graph stage는 90문장씩 분할하고 원자 commit은 상한 초과를 거부한다", () => {
  const statements = Array.from({ length: 181 }, (_, index) => index);
  assert.deepEqual(chunkD1Statements(statements).map((chunk) => chunk.length), [90, 90, 1]);
  assert.equal(D1_GRAPH_BATCH_STATEMENT_LIMIT, 90);
  assert.doesNotThrow(() => assertD1AtomicBatchLimit(statements.slice(0, 90), "fixture"));
  assert.throws(
    () => assertD1AtomicBatchLimit(statements.slice(0, 91), "fixture"),
    /원자 batch 상한 90개를 초과/,
  );
});
