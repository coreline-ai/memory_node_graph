import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireRuntimeSingletonLock,
  RuntimeAlreadyRunningError,
} from "../.runtime-dist/server/runtime/singleton-lock.js";

test("통합 poller singleton lock은 중복 실행을 막고 stale PID를 복구한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-runtime-lock-test-"));
  const path = join(directory, "runtime.lock");
  try {
    const release = await acquireRuntimeSingletonLock(path, 111, (pid) => pid === 111);
    await assert.rejects(
      acquireRuntimeSingletonLock(path, 222, (pid) => pid === 111),
      RuntimeAlreadyRunningError,
    );
    assert.equal((await readFile(path, "utf8")).trim(), "111");
    await release();

    await writeFile(path, "333");
    const releaseRecovered = await acquireRuntimeSingletonLock(path, 444, () => false);
    assert.equal((await readFile(path, "utf8")).trim(), "444");
    await releaseRecovered();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
