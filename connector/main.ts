import { connectorConfig } from "./config.js";
import { ConnectorRunner } from "./runner.js";
import { parseConnectorRunOptions } from "./run-policy.js";

const runner = new ConnectorRunner(connectorConfig);
const runOptions = parseConnectorRunOptions(process.argv.slice(2));
let signalCount = 0;
const shutdown = (signal: string) => {
  signalCount += 1;
  console.info(`[atlas-connector] shutdown signal=${signal}`);
  runner.stop();
  if (signalCount > 1) process.exit(130);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runner.run(runOptions)
  .then((receipt) => {
    console.info(`[atlas-connector] receipt ${JSON.stringify(receipt)}`);
  })
  .catch((error) => {
    console.error(`[atlas-connector] fatal message=${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  });
