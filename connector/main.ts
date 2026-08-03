import { connectorConfig } from "./config.js";
import { ConnectorRunner } from "./runner.js";

const runner = new ConnectorRunner(connectorConfig);
let signalCount = 0;
const shutdown = (signal: string) => {
  signalCount += 1;
  console.info(`[atlas-connector] shutdown signal=${signal}`);
  runner.stop();
  if (signalCount > 1) process.exit(130);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runner.run({ once: process.argv.includes("--once") }).catch((error) => {
  console.error(`[atlas-connector] fatal message=${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
});
