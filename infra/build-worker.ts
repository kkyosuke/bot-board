import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const entryPath = resolve(repoRoot, "src", "worker", "index.ts");
const outDir = resolve(repoRoot, "dist", "worker");
const outFile = resolve(outDir, "index.js");

const result = await Bun.build({
  entrypoints: [entryPath],
  outdir: outDir,
  target: "node",
  conditions: ["workerd", "worker", "module", "browser"],
  format: "esm",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }
  process.exit(1);
}

if (!existsSync(outFile)) {
  process.stderr.write(`Expected worker bundle at ${outFile} was not produced.\n`);
  process.exit(1);
}

const rawBytes = readFileSync(outFile);
const gzipBytes = Bun.gzipSync(rawBytes);

process.stdout.write(
  `✓ Built Cloudflare Worker bundle: dist/worker/index.js (${(rawBytes.byteLength / 1024).toFixed(1)} kB raw / ${(gzipBytes.byteLength / 1024).toFixed(1)} kB gzip)\n`,
);
