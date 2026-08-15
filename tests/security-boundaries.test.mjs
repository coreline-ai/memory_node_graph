import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await routeFiles(child));
    else if (entry.isFile() && entry.name === "route.ts") files.push(child);
  }
  return files;
}

test("every state-changing API route declares a write or internal-runtime guard", async () => {
  const files = await routeFiles(new URL("../app/api/", import.meta.url));
  const unguarded = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!/export async function (?:POST|PUT|PATCH|DELETE)\b/.test(source)) continue;
    if (!/requireAtlas(?:Write|Runtime)Access/.test(source)) unguarded.push(file.pathname);
  }
  assert.deepEqual(unguarded, []);
});

test("the integrated launcher binds both development and production web servers to loopback", async () => {
  const [source, viteConfig] = await Promise.all([
    readFile(new URL("../scripts/start-integrated-app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /const hostname = "127\.0\.0\.1"/);
  assert.match(source, /"--hostname",\s*hostname/);
  assert.match(viteConfig, /allowedHosts: allowedAtlasHosts/);
  assert.match(viteConfig, /ATLAS_EXPOSURE_MODE !== "proxy"/);
  assert.match(viteConfig, /ATLAS_APP_ORIGIN/);
});

test("Atlas access guard source defines explicit host, origin, and proxy-read denial codes", async () => {
  const source = await readFile(new URL("../app/lib/auth/write-access.ts", import.meta.url), "utf8");
  assert.match(source, /ATLAS_HOST_FORBIDDEN/);
  assert.match(source, /ATLAS_CROSS_SITE_FORBIDDEN/);
  assert.match(source, /ATLAS_ORIGIN_FORBIDDEN/);
  assert.match(source, /export function requireAtlasReadAccess/);
  assert.match(source, /exposureMode\(\) === "proxy"/);
});

test("full D1 read routes opt into the shared proxy read guard", async () => {
  const routes = [
    "../app/api/documents/route.ts",
    "../app/api/graph/route.ts",
    "../app/api/graph/query/route.ts",
    "../app/api/graph/documents/route.ts",
    "../app/api/graph/search/route.ts",
    "../app/api/graph/revision/route.ts",
    "../app/api/ingestion-jobs/[jobId]/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /requireAtlasReadAccess/, `${route} must protect full D1 reads in proxy mode`);
  }
});

test("internal errors are redacted and metadata ignores untrusted forwarded hosts", async () => {
  const [errorSource, layoutSource] = await Promise.all([
    readFile(new URL("../app/lib/http/api-error.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(errorSource, /requestId/);
  assert.match(errorSource, /\[redacted\]/);
  assert.match(errorSource, /status: 500/);
  assert.match(layoutSource, /ATLAS_APP_ORIGIN/);
  assert.doesNotMatch(layoutSource, /get\("x-forwarded-host"\)/);
});

test("public CI keeps source verification and production dependency audit in the read-only job", async () => {
  const source = await readFile(new URL("../.github/workflows/public-atlas-check.yml", import.meta.url), "utf8");
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(source, /npm audit --omit=dev --audit-level=high/);
  assert.match(source, /npm run graph:verify-public-sources/);
});
