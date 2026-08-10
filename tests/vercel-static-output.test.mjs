import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname;
const verifierPath = new URL("../scripts/verify-vercel-static-output.mjs", import.meta.url).pathname;
const atlasFiles = [
  "atlas-graph-snapshot.json",
  "atlas-graph-manifest.json",
  "atlas-graph-snapshot.sha256",
  "atlas-gold-snapshot.json",
  "atlas-gold-snapshot.sha256",
];

const makeOutput = async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-vercel-output-"));
  await Promise.all([
    mkdir(join(root, "assets"), { recursive: true }),
    mkdir(join(root, "atlas"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "index.html"), "<!doctype html><div id=\"root\"></div><script src=\"/assets/app-abc123.js\"></script>\n"),
    writeFile(join(root, "assets/app-abc123.js"), "document.documentElement.dataset.atlas='public';\n"),
    writeFile(join(root, "assets/app-abc123.css"), "html{background:#05090b}\n"),
    copyFile(join(projectRoot, "public/favicon.svg"), join(root, "favicon.svg")),
    copyFile(join(projectRoot, "public/og.png"), join(root, "og.png")),
    ...atlasFiles.map((name) => copyFile(
      join(projectRoot, "public/atlas", name),
      join(root, "atlas", name),
    )),
  ]);
  return root;
};

const verify = (directory) => execFileAsync(
  process.execPath,
  [verifierPath, directory],
  { cwd: projectRoot },
);

test("Vercel 정적 output verifier는 정상 공개 artifact를 승인한다", async (t) => {
  const output = await makeOutput();
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await verify(output);
  const report = JSON.parse(result.stdout);
  assert.equal(report.functions, 0);
  assert.equal(report.internalApiPaths, 0);
  assert.equal(report.databaseClients, 0);
  assert.equal(report.sourceMaps, 0);
});

test("Vercel 정적 output verifier는 snapshot 변조를 차단한다", async (t) => {
  const output = await makeOutput();
  t.after(() => rm(output, { recursive: true, force: true }));
  const path = join(output, "atlas/atlas-graph-snapshot.json");
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace("atlas-public-graph/v1", "atlas-public-graph/v0"));
  await assert.rejects(verify(output), /snapshot|checksum|SHA/i);
});

test("Vercel 정적 output verifier는 필수 snapshot 누락을 차단한다", async (t) => {
  const output = await makeOutput();
  t.after(() => rm(output, { recursive: true, force: true }));
  await unlink(join(output, "atlas/atlas-graph-snapshot.json"));
  await assert.rejects(verify(output), /필수 정적 파일 누락/);
});

test("Vercel 정적 output verifier는 API·DB·secret bundle을 차단한다", async (t) => {
  const output = await makeOutput();
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(
    join(output, "assets/app-abc123.js"),
    `fetch('/api/graph'); const client='drizzle-orm'; const token='gho_${"a".repeat(30)}';\n`,
  );
  await assert.rejects(verify(output), /internal API path|database client|GitHub token/i);
});
