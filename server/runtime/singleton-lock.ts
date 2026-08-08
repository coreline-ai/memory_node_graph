import { open, readFile, unlink } from "node:fs/promises";

export class RuntimeAlreadyRunningError extends Error {
  constructor(readonly pid?: number) {
    super(pid ? `통합 Codex 런타임이 이미 실행 중입니다. pid=${pid}` : "통합 Codex 런타임이 이미 실행 중입니다.");
    this.name = "RuntimeAlreadyRunningError";
  }
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function acquireRuntimeSingletonLock(
  path: string,
  pid = process.pid,
  isAlive: (candidate: number) => boolean = processAlive,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(pid));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
        if (owner === pid) await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (Number.isSafeInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new RuntimeAlreadyRunningError(owner);
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new RuntimeAlreadyRunningError();
}
