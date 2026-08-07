import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("모션 감소 환경은 자동 시작을 막되 사용자의 명시적 회전 선택은 저속으로 유지한다", async () => {
  const rotation = await importTypeScript("../app/graph/auto-rotate.ts");

  const reducedInitial = rotation.initialAutoRotateIntent(true);
  assert.deepEqual(reducedInitial, { enabled: false, userControlled: false });
  assert.equal(rotation.autoRotateStatusText(reducedInitial, true), "감소 모션 · 자동 회전 정지");

  const userEnabled = rotation.toggleAutoRotateIntent(reducedInitial);
  assert.deepEqual(userEnabled, { enabled: true, userControlled: true });
  assert.deepEqual(
    rotation.reconcileAutoRotateMotionPreference(userEnabled, true),
    userEnabled,
  );
  assert.equal(rotation.autoRotateSpeed(true), rotation.AUTO_ROTATE_SPEED.reducedMotion);
  assert.ok(rotation.autoRotateSpeed(true) < rotation.autoRotateSpeed(false));
  assert.equal(rotation.autoRotateStatusText(userEnabled, true), "감소 모션 · 저속 회전");
});

test("사용자 선택 전의 자동 회전은 시스템 모션 환경 변화에 맞춰 동기화한다", async () => {
  const rotation = await importTypeScript("../app/graph/auto-rotate.ts");

  const standardInitial = rotation.initialAutoRotateIntent(false);
  assert.deepEqual(standardInitial, { enabled: true, userControlled: false });
  assert.deepEqual(
    rotation.reconcileAutoRotateMotionPreference(standardInitial, true),
    { enabled: false, userControlled: false },
  );
  assert.deepEqual(
    rotation.reconcileAutoRotateMotionPreference(rotation.initialAutoRotateIntent(true), false),
    { enabled: true, userControlled: false },
  );
});
