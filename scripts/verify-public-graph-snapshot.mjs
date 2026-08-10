import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyPublicGraphArtifacts } from "./lib/public-graph-artifact.mjs";

const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const root = resolve(new URL("..", import.meta.url).pathname);
const inputDirectory = resolve(root, option("--input") ?? "public/atlas");
const artifacts = {
  snapshotText: await readFile(join(inputDirectory, "atlas-graph-snapshot.json"), "utf8"),
  manifestText: await readFile(join(inputDirectory, "atlas-graph-manifest.json"), "utf8"),
  checksumText: await readFile(join(inputDirectory, "atlas-graph-snapshot.sha256"), "utf8"),
};

console.log(JSON.stringify({
  inputDirectory,
  ...verifyPublicGraphArtifacts(artifacts),
}, null, 2));
