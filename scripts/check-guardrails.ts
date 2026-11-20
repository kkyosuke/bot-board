import { join } from "node:path";

import { validateRepositoryGuardrails } from "./lib/guardrail-checker";

const repoRoot = join(import.meta.dir, "..");
const report = validateRepositoryGuardrails(repoRoot);

if (!report.ok) {
  for (const err of report.errors) {
    process.stderr.write(`error: ${err}\n`);
  }
  process.stderr.write(
    `\nGuardrail check failed with ${report.errors.length} error(s) across ${report.checkedMarkdownFiles} Markdown files.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `✓ Guardrail check passed (${report.checkedMarkdownFiles} Markdown files, ${report.checkedProhibitionBullets} prohibition rules verified)\n`,
);
