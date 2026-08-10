import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text, verifyPublicGraphArtifacts } from "./lib/public-graph-artifact.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(projectRoot, process.argv[2] ?? "dist-vercel");
const normalizePath = (value) => value.split(sep).join("/");

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const requiredPaths = [
  "index.html",
  "atlas/atlas-graph-snapshot.json",
  "atlas/atlas-graph-manifest.json",
  "atlas/atlas-graph-snapshot.sha256",
  "atlas/atlas-gold-snapshot.json",
  "atlas/atlas-gold-snapshot.sha256",
  "favicon.svg",
  "og.png",
];
const allowedExtensions = new Set([
  ".html", ".js", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".txt", ".sha256",
]);
const textExtensions = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ".sha256"]);
const forbiddenRuntimeContent = [
  { name: "internal API path", pattern: /\/api\/(?:graph|documents|runtime|github|enrichment|ingestion)/i },
  { name: "Cloudflare runtime", pattern: /(?:@cloudflare\/|D1Database|\.wrangler)/ },
  { name: "server database client", pattern: /(?:drizzle-orm|better-sqlite|node:sqlite)/i },
  { name: "Codex server SDK", pattern: /@openai\/codex-sdk/i },
];
const forbiddenSensitiveContent = [
  { name: "macOS local path", pattern: /\/(?:Users|Volumes)\/[^\s"']+/ },
  { name: "temporary local path", pattern: /\/private\/var\/folders\/[^\s"']+/ },
  { name: "GitHub token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const outputStat = await stat(outputDirectory).catch(() => null);
if (!outputStat?.isDirectory()) {
  throw new Error(`Vercel 정적 output을 찾을 수 없습니다: ${outputDirectory}`);
}

const absoluteFiles = await walk(outputDirectory);
const files = absoluteFiles.map((path) => normalizePath(relative(outputDirectory, path))).sort();
const errors = [];

for (const requiredPath of requiredPaths) {
  if (!files.includes(requiredPath)) errors.push(`필수 정적 파일 누락: ${requiredPath}`);
}
if (!files.some((path) => /^assets\/[^/]+\.js$/.test(path))) errors.push("hash된 JavaScript asset 누락");
if (!files.some((path) => /^assets\/[^/]+\.css$/.test(path))) errors.push("hash된 CSS asset 누락");

for (const path of files) {
  const extension = extname(path).toLowerCase();
  if (!allowedExtensions.has(extension)) errors.push(`허용되지 않은 output 확장자: ${path}`);
  if (/(^|\/)(?:api|server|functions?|\.vercel|\.wrangler)(?:\/|$)/i.test(path)) {
    errors.push(`server/function 경로 포함: ${path}`);
  }
  if (/\.(?:map|sqlite3?|db|pem)$/i.test(path)) errors.push(`금지된 배포 파일 포함: ${path}`);
}

for (const path of files.filter((item) => textExtensions.has(extname(item).toLowerCase()))) {
  const content = await readFile(resolve(outputDirectory, path), "utf8");
  for (const forbidden of forbiddenSensitiveContent) {
    if (forbidden.pattern.test(content)) errors.push(`${path}: ${forbidden.name} 포함`);
  }
  if ([".html", ".js", ".css"].includes(extname(path).toLowerCase())) {
    for (const forbidden of forbiddenRuntimeContent) {
      if (forbidden.pattern.test(content)) errors.push(`${path}: ${forbidden.name} 포함`);
    }
  }
}

if (!errors.length) {
  verifyPublicGraphArtifacts({
    snapshotText: await readFile(resolve(outputDirectory, "atlas/atlas-graph-snapshot.json"), "utf8"),
    manifestText: await readFile(resolve(outputDirectory, "atlas/atlas-graph-manifest.json"), "utf8"),
    checksumText: await readFile(resolve(outputDirectory, "atlas/atlas-graph-snapshot.sha256"), "utf8"),
  });
  const goldText = await readFile(resolve(outputDirectory, "atlas/atlas-gold-snapshot.json"), "utf8");
  const goldChecksum = await readFile(resolve(outputDirectory, "atlas/atlas-gold-snapshot.sha256"), "utf8");
  const gold = JSON.parse(goldText);
  const goldSha256 = sha256Text(goldText);
  if (goldChecksum.trim() !== `${goldSha256}  atlas-gold-snapshot.json`) {
    errors.push("Gold Graph checksum 불일치");
  }
  if (gold.schemaVersion !== "atlas-public-fixture-graph/v1"
    || gold.meta?.publicFixture !== true
    || gold.nodes?.length !== 68
    || gold.edges?.length !== 101) {
    errors.push("Gold Graph 공개 fixture 계약 불일치");
  }
  const goldNodeIds = new Set((gold.nodes ?? []).map((node) => node.id));
  if ((gold.edges ?? []).some((edge) => !goldNodeIds.has(edge.source) || !goldNodeIds.has(edge.target))) {
    errors.push("Gold Graph orphan edge 포함");
  }
  if (/"(?:documentId|blockId|sourceUrl|evidence|repositoryId)"\s*:/.test(goldText)) {
    errors.push("Gold Graph 내부 provenance 필드 포함");
  }
}

if (errors.length) {
  throw new Error(`Vercel 정적 output 검증 실패:\n- ${[...new Set(errors)].join("\n- ")}`);
}

const bytes = (await Promise.all(absoluteFiles.map(async (path) => (await stat(path)).size)))
  .reduce((total, size) => total + size, 0);

console.log(JSON.stringify({
  outputDirectory,
  fileCount: files.length,
  bytes,
  functions: 0,
  internalApiPaths: 0,
  databaseClients: 0,
  sourceMaps: 0,
  files,
}, null, 2));
