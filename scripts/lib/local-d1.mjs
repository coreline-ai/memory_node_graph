import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function resolveLocalD1Database(input = {}) {
  if (input.requested) {
    const requested = resolve(input.requested);
    let requestedStat;
    try {
      requestedStat = await stat(requested);
    } catch {
      throw new Error(`지정한 로컬 D1 파일을 찾을 수 없습니다: ${requested}`);
    }
    if (!requestedStat.isFile()) {
      throw new Error(`지정한 로컬 D1 경로가 파일이 아닙니다: ${requested}`);
    }
    if (!requested.endsWith(".sqlite") || requested.endsWith("/metadata.sqlite")) {
      throw new Error(`지정한 파일은 로컬 D1 SQLite 정본이 아닙니다: ${requested}`);
    }
    return requested;
  }
  const root = resolve(input.root ?? process.cwd());
  const directory = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`로컬 D1 디렉터리를 찾을 수 없습니다: ${directory}`);
  }
  const databases = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite")
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (databases.length === 0) {
    throw new Error(`로컬 D1 파일을 찾을 수 없습니다: ${directory}`);
  }
  if (databases.length > 1) {
    throw new Error(`로컬 D1 파일이 여러 개입니다. --db 또는 --database를 지정하세요: ${databases.join(", ")}`);
  }
  return databases[0];
}
