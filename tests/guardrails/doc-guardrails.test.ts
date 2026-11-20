import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateRepositoryGuardrails } from "../../scripts/lib/guardrail-checker";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function buildPlanMarkdown(s1Status = "未着手", scopeExtra = "DB"): string {
  return [
    "# Plan",
    "",
    "| Slice | Phase | スコープ | UI Artifact | 検証 | 状態 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| **S0** (#4, #6) | Phase 1 | Guardrails | 不要 | CI | **実装済** |",
    `| **S1** | Phase 1 | ${scopeExtra} | 不要 | test | ${s1Status} |`,
    "| **S2** | Phase 1 | Bot | 不要 | test | 未着手 |",
    "| **S3** | Phase 1 | Human | 不要 | test | 未着手 |",
    "| **S4** | Phase 1 | OAuth | 必須 | MCP | 未着手 |",
    "| **S5** | Phase 2 | Card UI | 必須 | E2E | 未着手 |",
    "| **S6** | Phase 2 | Board UI | 必須 | E2E | 未着手 |",
    "| **S7** | Phase 3 | Worker | 不要 | test | 未着手 |",
    "| **S8** | Phase 3 | Full E2E | 変更時のみ | E2E | 未着手 |",
    "",
  ].join("\n");
}

function createMinimalDocsRepo(
  callback: (root: string) => void,
): ReturnType<typeof validateRepositoryGuardrails> {
  const tempRoot = mkdtempSync(join(tmpdir(), "bot-board-doc-guard-"));
  try {
    mkdirSync(join(tempRoot, "docs"), { recursive: true });
    mkdirSync(join(tempRoot, "src"), { recursive: true });
    writeFileSync(join(tempRoot, "bunfig.toml"), "[fmt]\n");
    writeFileSync(join(tempRoot, "src", "check.ts"), "export const ok = true;\n");
    writeFileSync(join(tempRoot, "README.md"), "# Sample\n\nSee [spec](docs/spec.md).\n");
    writeFileSync(join(tempRoot, "AGENTS.md"), "# Agents\n\nSee [spec](docs/spec.md).\n");
    writeFileSync(join(tempRoot, "docs", "implementation-plan.md"), buildPlanMarkdown());
    writeFileSync(
      join(tempRoot, "docs", "bot-integration.md"),
      [
        "# Bot",
        "",
        "## 接続実証と完了基準",
        "",
        "| 経路 | 実証項目 | 現在 |",
        "| --- | --- | --- |",
        "| ChatGPT | 検証 | 未実施 |",
        "| Claude | 検証 | 未実施 |",
        "| Meta Muse | 検証 | 未特定 |",
        "| Google Gemini | 検証 | 未実施 |",
        "| Grok | 検証 | 未実施 |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tempRoot, "docs", "spec.md"),
      [
        "# Spec",
        "",
        "```mermaid",
        "flowchart LR",
        '  A["timeout < lease"] --> B["End"]',
        "```",
        "",
        "- 禁止：直接アクセス（強制: `bunfig.toml`, `src/check.ts`）",
        "- 禁止：次フェーズ制約（強制: `S1予定`）",
        "- 禁止：合意前着手（強制: Gate）",
        "",
      ].join("\n"),
    );

    callback(tempRoot);
    return validateRepositoryGuardrails(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("documentation and guardrail ratchet checker", () => {
  test("live repository passes all documentation and guardrail checks", () => {
    const report = validateRepositoryGuardrails(REPO_ROOT);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedMarkdownFiles).toBeGreaterThanOrEqual(8);
    expect(report.checkedProhibitionBullets).toBeGreaterThanOrEqual(24);
  });

  test("minimal valid fixture passes cleanly and handles CommonMark inline triple/double backticks and < in Mermaid", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "examples.md"),
        [
          "# Examples",
          "",
          "Inline code `` `[missing](does-not-exist.md)` `` is ignored.",
          "Inline triple ```foo``` at line start does not open an unclosed fence.",
          "",
          "```markdown",
          "## 変更履歴",
          "- 禁止：コードフェンス内の例示はタグ不要",
          "[missing](nope.md)",
          "```",
          "",
          "- 禁止：インライン3連の後も通常通り検査される（強制: Gate）",
          "",
        ].join("\n"),
      );
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("rejects unclosed code fences at EOF instead of silently skipping trailing prose", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "unclosed.md"),
        ["# Broken", "", "```mermaid", "gantt", "  title Bad"].join("\n"),
      );
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("Unclosed code fence"))).toBe(true);
  });

  test("rejects prohibition bullets without tag, with trailing comma, with .. traversal, or in AGENTS.md", () => {
    const variantsReport = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "AGENTS.md"),
        "# Agents\n\n1. **禁止**：番号付きタグなし\n- 禁止：末尾カンマ（強制: `bunfig.toml`, ）\n- 禁止：親参照偽装（強制: `src/../docs/spec.md`）\n",
      );
    });

    expect(variantsReport.ok).toBe(false);
    expect(
      variantsReport.errors.some((e) => e.includes("AGENTS.md:3: Prohibition guardrail")),
    ).toBe(true);
    expect(variantsReport.errors.some((e) => e.includes("Empty or trailing comma"))).toBe(true);
    expect(variantsReport.errors.some((e) => e.includes("Invalid enforcement token"))).toBe(true);
  });

  test("rejects symlinks in docs/ or enforcement targets", () => {
    const symlinkDocReport = createMinimalDocsRepo((root) => {
      symlinkSync(join(root, "README.md"), join(root, "docs", "linked.md"));
      symlinkSync("/etc/hosts", join(root, "src", "fake-check.ts"));
      writeFileSync(
        join(root, "docs", "sym-target.md"),
        "# Sym\n\n- 禁止：シンボリックリンク強制先（強制: `src/fake-check.ts`）\n",
      );
    });

    expect(symlinkDocReport.ok).toBe(false);
    expect(
      symlinkDocReport.errors.some((e) =>
        e.includes("docs/linked.md: Symbolic links are disallowed"),
      ),
    ).toBe(true);
    expect(symlinkDocReport.errors.some((e) => e.includes("symbolic links are disallowed"))).toBe(
      true,
    );
  });

  test("rejects deferred slice tag (S1予定) even when implementation-plan.md contains escaped pipes \\| and surrogate pairs", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "implementation-plan.md"),
        buildPlanMarkdown("**実装済**", "A \\| B \\| `🚀 C | D`"),
      );
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("already-implemented slice S1"))).toBe(true);
  });

  test("rejects broken relative links, leading-slash links, file:// links, outer/inner nested-bracket links, and reference links", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "links.md"),
        [
          "# Links",
          "",
          "See [abs](/docs/spec.md), [local](file:///tmp/x.md), [![img](missing-inner.png)](missing.md), and [escape](../../outside.md).",
          "",
          "[ref-broken]: nope.md",
          "",
        ].join("\n"),
      );
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('without leading "/"'))).toBe(true);
    expect(report.errors.some((e) => e.includes("Local/unsafe URI scheme"))).toBe(true);
    expect(report.errors.some((e) => e.includes('Invalid relative link "missing-inner.png"'))).toBe(
      true,
    );
    expect(report.errors.some((e) => e.includes('Invalid relative link "missing.md"'))).toBe(true);
    expect(report.errors.some((e) => e.includes('Invalid relative link "nope.md"'))).toBe(true);
    expect(report.errors.some((e) => e.includes("escapes repository root"))).toBe(true);
  });

  test("rejects legacy stateDiagram v1, literal \\n, and HTML tags in Mermaid", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "mermaid-bad.md"),
        [
          "# Diagrams",
          "",
          "```mermaid",
          "stateDiagram",
          "  [*] --> Ready",
          "```",
          "",
          "```mermaid",
          "flowchart LR",
          '  A["Line1\\nLine2"] --> B["<b>HTML</b>"]',
          "```",
          "",
        ].join("\n"),
      );
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("Unsupported Mermaid"))).toBe(true);
    expect(report.errors.some((e) => e.includes('literal "\\n"'))).toBe(true);
    expect(report.errors.some((e) => e.includes("HTML tag"))).toBe(true);
  });

  test("rejects prohibited changelog headings and pre-S4 検証済/対応済 status claims", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(join(root, "AGENTS.md"), "# Agents\n\n## 変更経緯\n\nText\n");
      writeFileSync(
        join(root, "docs", "bot-integration.md"),
        [
          "# Bot",
          "",
          "| 経路 | 実証項目 | 現在 |",
          "| --- | --- | --- |",
          "| ChatGPT | 検証 | 検証済 |",
          "| Claude | 検証 | 未実施 |",
          "| Meta Muse | 検証 | 未特定 |",
          "| Google Gemini | 検証 | 未実施 |",
          "| Grok | 検証 | 未実施 |",
          "",
        ].join("\n"),
      );
    });

    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) => e.includes("AGENTS.md:3: Prohibited changelog/discussion heading")),
    ).toBe(true);
    expect(report.errors.some((e) => e.includes("before Slice S4 is implemented"))).toBe(true);
  });

  test("rejects AC mismatch between implementation-plan.md §2 slice rows and §3 AC trace table", () => {
    const report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "implementation-plan.md"),
        [
          "# Plan",
          "",
          "| Slice | Phase | スコープ | UI Artifact | 主な検証対象 | 状態 |",
          "| --- | --- | --- | --- | --- | --- |",
          "| **S0** | Phase 1 | Guardrails | 不要 | CI | **実装済** |",
          "| **S1** | Phase 1 | DB | 不要 | `DEC-04` | 未着手 |",
          "| **S2** | Phase 1 | Bot | 不要 | test | 未着手 |",
          "| **S3** | Phase 1 | Human | 不要 | `DEC-04` | 未着手 |",
          "| **S4** | Phase 1 | OAuth | 必須 | MCP | 未着手 |",
          "| **S5** | Phase 2 | Card UI | 必須 | `UX-01`〜`02`, `DEC-04` | **実装済** |",
          "| **S6** | Phase 2 | Board UI | 必須 | E2E | 未着手 |",
          "| **S7** | Phase 3 | Worker | 不要 | test | 未着手 |",
          "| **S8** | Phase 3 | Full E2E | 変更時のみ | E2E | 未着手 |",
          "",
          "| AC ID | 要件 | 実装スライス | 最終E2E検証 |",
          "| --- | --- | --- | --- |",
          "| `UX-01` | Swipe | S5 | S8 |",
          "| `UX-02` | SP/PC | S5 | S8 |",
          "| `DEC-04` | Group lock | S1, S3 | S8 |",
          "",
        ].join("\n"),
      );
    });

    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) => e.includes('Slice S5 claims AC "DEC-04"') && e.includes("S5")),
    ).toBe(true);
  });

  test("still blocks 対応済/検証済 when S8 is implemented but S4 is code-only (undeployed), blocks Muse 対応済 while unidentified, and blocks blanket claims (B1)", () => {
    const undeployedS4Report = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "implementation-plan.md"),
        [
          "# Plan",
          "",
          "| Slice | Phase | スコープ | UI Artifact | 主な検証対象 | 状態 |",
          "| --- | --- | --- | --- | --- | --- |",
          "| **S0** | Phase 1 | Guardrails | 不要 | CI | **実装済** |",
          "| **S1** | Phase 1 | DB | 不要 | test | **実装済** |",
          "| **S2** | Phase 1 | Bot | 不要 | test | **実装済** |",
          "| **S3** | Phase 1 | Human | 不要 | test | **実装済** |",
          "| **S4** | Phase 1 | OAuth | 必須 | MCP | **コード実装済**（検証環境デプロイは認証情報設定後） |",
          "| **S5** | Phase 2 | Card UI | 必須 | E2E | **実装済** |",
          "| **S6** | Phase 2 | Board UI | 必須 | E2E | **実装済** |",
          "| **S7** | Phase 3 | Worker | 不要 | test | **実装済** |",
          "| **S8** | Phase 3 | Full E2E | 変更時のみ | E2E | **実装済** |",
          "",
          "| 項目 | 現状 | 扱い |",
          "| --- | --- | --- |",
          "| Muse の正式名称・URL | 未特定（`#19` 起票済） | 特定後に追加 |",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "docs", "bot-integration.md"),
        [
          "# Bot",
          "",
          "| 経路 | 実証項目 | 現在 |",
          "| --- | --- | --- |",
          "| ChatGPT公式クライアント | 検証 | 対応済 |",
          "| Claude公式クライアント | 検証 | 検証済 |",
          "| Meta Muse | 検証 | 未特定 |",
          "| Google Gemini | 検証 | 未実施 |",
          "| Grok APIワーカー | 検証 | 未実施 |",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "docs", "concept.md"),
        "# Concept\n\n現在5種類対応済みです。\n全種類対応済みの状態です。\n",
      );
    });

    expect(undeployedS4Report.ok).toBe(false);
    expect(
      undeployedS4Report.errors.some(
        (e) =>
          e.includes('Channel "ChatGPT公式クライアント"') &&
          e.includes("before Slice S4 is implemented and deployed"),
      ),
    ).toBe(true);
    expect(
      undeployedS4Report.errors.some(
        (e) =>
          e.includes('Channel "Claude公式クライアント"') &&
          e.includes("before Slice S4 is implemented and deployed"),
      ),
    ).toBe(true);
    expect(
      undeployedS4Report.errors.filter((e) => e.includes("Premature blanket Bot support claim"))
        .length,
    ).toBe(2);

    // Even after S4 is deployed & S8 is implemented, Muse must stay 未特定 while unidentified in §4
    const museClaimAfterDeployReport = createMinimalDocsRepo((root) => {
      writeFileSync(
        join(root, "docs", "implementation-plan.md"),
        [
          "# Plan",
          "",
          "| Slice | Phase | スコープ | UI Artifact | 主な検証対象 | 状態 |",
          "| --- | --- | --- | --- | --- | --- |",
          "| **S0** | Phase 1 | Guardrails | 不要 | CI | **実装済** |",
          "| **S1** | Phase 1 | DB | 不要 | test | **実装済** |",
          "| **S2** | Phase 1 | Bot | 不要 | test | **実装済** |",
          "| **S3** | Phase 1 | Human | 不要 | test | **実装済** |",
          "| **S4** | Phase 1 | OAuth | 必須 | MCP | **実装済** |",
          "| **S5** | Phase 2 | Card UI | 必須 | E2E | **実装済** |",
          "| **S6** | Phase 2 | Board UI | 必須 | E2E | **実装済** |",
          "| **S7** | Phase 3 | Worker | 不要 | test | **実装済** |",
          "| **S8** | Phase 3 | Full E2E | 変更時のみ | E2E | **実装済** |",
          "",
          "| 項目 | 現状 | 扱い |",
          "| --- | --- | --- |",
          "| Muse の正式名称・URL | 未特定（`#19` 起票済） | 特定後に追加 |",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "docs", "bot-integration.md"),
        [
          "# Bot",
          "",
          "| 経路 | 実証項目 | 現在 |",
          "| --- | --- | --- |",
          "| ChatGPT公式クライアント | 検証 | 対応済 |",
          "| Claude公式クライアント | 検証 | 対応済 |",
          "| Google Gemini | 検証 | 対応済 |",
          "| Grok APIワーカー | 検証 | 対応済 |",
          "| Muse | 検証 | 対応済 |",
          "",
        ].join("\n"),
      );
    });

    expect(museClaimAfterDeployReport.ok).toBe(false);
    expect(
      museClaimAfterDeployReport.errors.some(
        (e) => e.includes('Channel "Muse"') && e.includes('must remain "未特定"'),
      ),
    ).toBe(true);
  });
});
