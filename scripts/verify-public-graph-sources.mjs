import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { PUBLIC_GRAPH_SOURCE_SCHEMA, stableJson } from "./lib/public-graph-artifact.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const write = process.argv.includes("--write");
const policyPath = resolve(root, option("--policy") ?? "config/public-graph-sources.json");
const policy = JSON.parse(await readFile(policyPath, "utf8"));
if (policy.schemaVersion !== PUBLIC_GRAPH_SOURCE_SCHEMA || !policy.owner || !Array.isArray(policy.repositories)) {
  throw new Error("공개 source 정책 파일 형식이 올바르지 않습니다.");
}

const { stdout } = await execFileAsync("gh", [
  "repo", "list", String(policy.owner),
  "--limit", "300",
  "--visibility", "public",
  "--json", "id,nameWithOwner,isPrivate,visibility,url",
], { maxBuffer: 4 * 1024 * 1024 });
const repositories = JSON.parse(stdout)
  .filter((item) => item.visibility === "PUBLIC" && item.isPrivate === false)
  .map((item) => ({
    githubId: String(item.id),
    nameWithOwner: String(item.nameWithOwner),
    url: String(item.url),
  }))
  .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner));
const configured = new Set(policy.repositories.map((item) => String(item.nameWithOwner).toLowerCase()));
const current = new Set(repositories.map((item) => item.nameWithOwner.toLowerCase()));
const added = [...current].filter((key) => !configured.has(key)).sort();
const removedOrPrivate = [...configured].filter((key) => !current.has(key)).sort();

if ((added.length || removedOrPrivate.length) && !write) {
  console.error(JSON.stringify({
    status: "drift",
    configured: configured.size,
    currentPublic: current.size,
    added,
    removedOrPrivate,
    action: "검토 후 `npm run graph:refresh-public-sources`를 실행하세요.",
  }, null, 2));
  process.exitCode = 1;
} else if (write && (added.length || removedOrPrivate.length)) {
  const nextPolicy = {
    ...policy,
    verification: "GitHub gh OAuth · visibility=PUBLIC · isPrivate=false",
    verifiedAt: new Date().toISOString(),
    repositories,
  };
  const temporaryPath = `${policyPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, stableJson(nextPolicy));
  await rename(temporaryPath, policyPath);
  console.log(JSON.stringify({
    status: "updated",
    configured: configured.size,
    currentPublic: current.size,
    added,
    removedOrPrivate,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    status: "current",
    configured: configured.size,
    currentPublic: current.size,
    added: [],
    removedOrPrivate: [],
  }, null, 2));
}
