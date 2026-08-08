import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const production = process.argv.includes("--production");
const port = Number(process.env.PORT) || 3000;
const baseUrl = process.env.ATLAS_RUNTIME_ORIGIN?.trim() || `http://localhost:${port}`;
const internalRuntimeSecret = process.env.ATLAS_INTERNAL_RUNTIME_SECRET?.trim()
  || randomBytes(32).toString("base64url");
const environment = {
  ...process.env,
  PORT: String(port),
  ATLAS_RUNTIME_ORIGIN: baseUrl,
  ATLAS_INTERNAL_RUNTIME_SECRET: internalRuntimeSecret,
};
const children = new Map();
let stopping = false;

const startChild = (command, arguments_, label) => {
  const child = spawn(command, arguments_, { env: environment, stdio: "inherit" });
  children.set(child, label);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && label === "web") {
      console.error(`[atlas-app] web exited code=${code ?? "none"} signal=${signal ?? "none"}`);
      shutdown(signal || "SIGTERM", code ?? 1);
    }
  });
  return child;
};

const waitForWeb = async () => {
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/runtime/codex/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Web process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`웹앱 준비 시간을 초과했습니다: ${baseUrl}`);
};

const shutdown = (signal = "SIGTERM", exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  for (const [child, label] of children) {
    if (label === "runtime") child.kill(signal);
  }
  // Keep the HTTP/D1 process alive briefly so the runtime can release its
  // active lease and persist the final offline state before web shutdown.
  setTimeout(() => {
    for (const [child, label] of children) {
      if (label === "web") child.kill(signal);
    }
  }, 1_000).unref();
  setTimeout(() => {
    for (const child of children.keys()) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 5_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT", 130));
process.on("SIGTERM", () => shutdown("SIGTERM", 143));

startChild(
  "npm",
  ["run", production ? "start:web" : "dev:web", "--", "--port", String(port)],
  "web",
);
try {
  await waitForWeb();
  if (!stopping) {
    console.info(`[atlas-app] web ready=${baseUrl}; starting integrated Codex OAuth runtime`);
    startChild("node", [".runtime-dist/server/runtime/main.js"], "runtime");
  }
} catch (error) {
  console.error(`[atlas-app] startup failed message=${error instanceof Error ? error.message : "unknown"}`);
  shutdown("SIGTERM", 1);
}

await new Promise((resolve) => {
  const interval = setInterval(() => {
    if (stopping && children.size === 0) {
      clearInterval(interval);
      resolve(undefined);
    }
  }, 200);
});
