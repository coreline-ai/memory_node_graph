import { resolve } from "node:path";
import {
  auditLocalD1Database,
  createLocalD1Backup,
  verifyBackupCopy,
} from "./lib/local-d1-baseline.mjs";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";

const args = new Set(process.argv.slice(2));
const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const root = resolve(new URL("..", import.meta.url).pathname);
const databasePath = await resolveLocalD1Database({ root, requested: option("--db") });

if (!args.has("--backup")) {
  console.log(JSON.stringify({ mode: "audit", ...auditLocalD1Database(databasePath) }, null, 2));
} else {
  const receipt = await createLocalD1Backup({
    databasePath,
    backupDirectory: option("--backup-directory"),
    reportDirectory: option("--report-directory") ?? resolve(root, ".wrangler", "reports"),
  });
  let restoreCheck;
  if (args.has("--restore-check")) {
    restoreCheck = await verifyBackupCopy(receipt.backupPath);
    if (restoreCheck.audit.dataFingerprint !== receipt.dataFingerprint) {
      throw new Error("임시 복구 DB의 fingerprint가 backup과 다릅니다.");
    }
  }
  console.log(JSON.stringify({
    mode: "backup",
    backupPath: receipt.backupPath,
    receiptPath: receipt.receiptPath,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    dataFingerprint: receipt.dataFingerprint,
    verification: receipt.verification,
    restoreCheck: restoreCheck ? {
      integrityCheck: restoreCheck.audit.integrityCheck,
      dataFingerprint: restoreCheck.audit.dataFingerprint,
    } : undefined,
  }, null, 2));
}
