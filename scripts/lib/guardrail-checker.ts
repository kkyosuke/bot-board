import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface GuardrailCheckReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly checkedMarkdownFiles: number;
  readonly checkedProhibitionBullets: number;
}

const ALLOWED_MERMAID_TYPES_PATTERN =
  /^(?:flowchart|graph|sequenceDiagram|stateDiagram-v2|erDiagram|classDiagram|xychart-beta)\b/;

const MERMAID_HTML_TAG_PATTERN =
  /<\/?(?:div|span|p|br|hr|b|i|u|strong|em|a|img|script|style|table|tr|td|th|ul|ol|li|code|pre|sub|sup|font|small|big|h[1-6])\b[^>]*>/i;

const BANNED_DOC_HEADING_PATTERN =
  /(変更履歴|修正履歴|更新履歴|変更経緯|修正経緯|議論ログ|試行錯誤|changelog)/i;

const ALLOWED_EXTERNAL_SCHEME_PATTERN = /^(?:https?:|mailto:|tel:)/i;
const BANNED_URI_SCHEME_PATTERN = /^(?:file:|ace:|conversation:|javascript:|data:|vbscript:)/i;

const ALLOWED_REPO_PATH_TOKEN_PATTERN =
  /^(?:bunfig\.toml|tsconfig\.json|package\.json|\.gitignore|\.github\/[^\s,]+|\.githooks\/[^\s,]+|src\/[^\s,]+|tests\/[^\s,]+|scripts\/[^\s,]+|infra\/[^\s,]+)$/;

const PLANNED_SLICE_TOKEN_PATTERN = /^(S[1-8])予定$/;
const PROHIBITION_LINE_PATTERN = /^\s*(?:>\s*)*(?:[-*+]|\d+\.)\s*\*{0,2}禁止\*{0,2}\s*[：:]/;
const EXPECTED_ALL_SLICES = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"] as const;

interface ParsedMarkdown {
  readonly proseLines: ReadonlyArray<{ readonly lineNumber: number; readonly text: string }>;
  readonly mermaidBlocks: ReadonlyArray<{
    readonly startLine: number;
    readonly lines: readonly string[];
  }>;
}

function collectMarkdownFiles(realRepoRoot: string, dirPath: string, errors: string[]): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relative(realRepoRoot, fullPath).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      errors.push(`${relPath}: Symbolic links are disallowed in documentation directories.`);
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(realRepoRoot, fullPath, errors));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function parseMarkdownFences(
  relFilePath: string,
  content: string,
  errors: string[],
): ParsedMarkdown {
  const rawLines = content.split(/\r?\n/);
  const proseLines: Array<{ readonly lineNumber: number; readonly text: string }> = [];
  const mermaidBlocks: Array<{ readonly startLine: number; readonly lines: readonly string[] }> =
    [];

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let fenceStartLine = 0;
  let currentFenceLines: string[] = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? "";
    const lineNumber = index + 1;

    if (!inFence) {
      const backtickOpen = /^\s*(`{3,})([^`]*)$/.exec(line);
      const tildeOpen = backtickOpen === null ? /^\s*(~{3,})(.*)$/.exec(line) : null;
      const openMatch = backtickOpen ?? tildeOpen;

      if (openMatch !== null) {
        const marker = openMatch[1] ?? "```";
        const infoString = (openMatch[2] ?? "").trim().toLowerCase();
        inFence = true;
        fenceChar = marker[0] ?? "`";
        fenceLen = marker.length;
        fenceLang = infoString.split(/\s+/)[0] ?? "";
        fenceStartLine = lineNumber;
        currentFenceLines = [];
        continue;
      }

      proseLines.push({ lineNumber, text: line });
      continue;
    }

    const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (
      closeMatch !== null &&
      (closeMatch[1]?.[0] ?? "") === fenceChar &&
      (closeMatch[1]?.length ?? 0) >= fenceLen
    ) {
      if (fenceLang === "mermaid") {
        mermaidBlocks.push({
          startLine: fenceStartLine,
          lines: currentFenceLines,
        });
      }
      inFence = false;
      fenceChar = "";
      fenceLen = 0;
      fenceLang = "";
      currentFenceLines = [];
      continue;
    }

    currentFenceLines.push(line);
  }

  if (inFence) {
    errors.push(
      `${relFilePath}:${fenceStartLine}: Unclosed code fence (missing closing ${fenceChar.repeat(fenceLen)}).`,
    );
  }

  return { proseLines, mermaidBlocks };
}

function stripInlineCodeSpans(line: string): string {
  const chars = line.split("");
  let idx = 0;

  while (idx < chars.length) {
    if (chars[idx] !== "`") {
      idx += 1;
      continue;
    }

    let openEnd = idx;
    while (openEnd < chars.length && chars[openEnd] === "`") {
      openEnd += 1;
    }
    const tickCount = openEnd - idx;

    let search = openEnd;
    let matchedCloseEnd = -1;
    while (search < chars.length) {
      if (chars[search] !== "`") {
        search += 1;
        continue;
      }
      let closeEnd = search;
      while (closeEnd < chars.length && chars[closeEnd] === "`") {
        closeEnd += 1;
      }
      if (closeEnd - search === tickCount) {
        matchedCloseEnd = closeEnd;
        break;
      }
      search = closeEnd;
    }

    if (matchedCloseEnd !== -1) {
      for (let fill = idx; fill < matchedCloseEnd; fill += 1) {
        chars[fill] = " ";
      }
      idx = matchedCloseEnd;
    } else {
      idx = openEnd;
    }
  }

  return chars.join("");
}

function splitMarkdownTableRow(line: string): string[] {
  const masked = stripInlineCodeSpans(line);
  const cells: string[] = [];
  let start = 0;

  for (let idx = 0; idx < masked.length; idx += 1) {
    if (masked[idx] === "|" && (idx === 0 || line[idx - 1] !== "\\")) {
      cells.push(line.slice(start, idx).trim());
      start = idx + 1;
    }
  }
  cells.push(line.slice(start).trim());

  if (cells[0] === "") {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1] === "") {
    cells.pop();
  }
  return cells;
}

function verifyExactRepoFile(
  realRepoRoot: string,
  candidateAbsPath: string,
  expectedCanonicalRel: string,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  const normalizedCandidate = resolve(candidateAbsPath);
  if (
    normalizedCandidate !== realRepoRoot &&
    !normalizedCandidate.startsWith(`${realRepoRoot}${sep}`)
  ) {
    return { valid: false, reason: "escapes repository root" };
  }

  if (!existsSync(normalizedCandidate)) {
    return { valid: false, reason: "target file not found" };
  }

  const stat = lstatSync(normalizedCandidate);
  if (stat.isSymbolicLink()) {
    return { valid: false, reason: "symbolic links are disallowed" };
  }
  if (!stat.isFile()) {
    return { valid: false, reason: "target is not a regular file" };
  }

  const realTarget = realpathSync.native(normalizedCandidate);
  if (!realTarget.startsWith(`${realRepoRoot}${sep}`)) {
    return { valid: false, reason: "escapes repository root via symlink" };
  }

  const actualCanonicalRel = relative(realRepoRoot, realTarget).split(sep).join("/");
  if (actualCanonicalRel !== expectedCanonicalRel) {
    return {
      valid: false,
      reason: `case or canonical path mismatch (actual: "${actualCanonicalRel}")`,
    };
  }

  return { valid: true };
}

function extractMarkdownLinkTargets(sanitizedLine: string): string[] {
  const targets: string[] = [];

  const refDefMatch = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(sanitizedLine);
  if (refDefMatch !== null && refDefMatch[1] !== undefined) {
    targets.push(refDefMatch[1]);
  }

  let idx = 0;
  while (idx < sanitizedLine.length) {
    const openBracket = sanitizedLine.indexOf("[", idx);
    if (openBracket === -1) {
      break;
    }

    let depth = 1;
    let cursor = openBracket + 1;
    while (cursor < sanitizedLine.length && depth > 0) {
      const ch = sanitizedLine[cursor];
      if (ch === "\\") {
        cursor += 2;
        continue;
      }
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
      }
      cursor += 1;
    }

    if (depth === 0 && sanitizedLine[cursor] === "(") {
      let parenDepth = 1;
      let parenCursor = cursor + 1;
      while (parenCursor < sanitizedLine.length && parenDepth > 0) {
        const ch = sanitizedLine[parenCursor];
        if (ch === "\\") {
          parenCursor += 2;
          continue;
        }
        if (ch === "(") {
          parenDepth += 1;
        } else if (ch === ")") {
          parenDepth -= 1;
        }
        parenCursor += 1;
      }

      if (parenDepth === 0) {
        targets.push(sanitizedLine.slice(cursor + 1, parenCursor - 1).trim());
        idx = openBracket + 1;
        continue;
      }
    }

    idx = openBracket + 1;
  }

  return targets;
}

function checkRelativeLinks(
  realRepoRoot: string,
  absFilePath: string,
  relFilePath: string,
  proseLines: ReadonlyArray<{ readonly lineNumber: number; readonly text: string }>,
  errors: string[],
): void {
  const baseDir = dirname(absFilePath);

  for (const { lineNumber, text } of proseLines) {
    const sanitized = stripInlineCodeSpans(text);
    const rawTargets = extractMarkdownLinkTargets(sanitized);

    for (const rawInner of rawTargets) {
      const unwrapped =
        rawInner.startsWith("<") && rawInner.endsWith(">")
          ? rawInner.slice(1, -1).trim()
          : (rawInner.split(/\s+/)[0] ?? "");

      if (unwrapped === "" || unwrapped.startsWith("#")) {
        continue;
      }

      if (BANNED_URI_SCHEME_PATTERN.test(unwrapped)) {
        errors.push(
          `${relFilePath}:${lineNumber}: Local/unsafe URI scheme in link "${unwrapped}" is disallowed in repository docs.`,
        );
        continue;
      }

      if (ALLOWED_EXTERNAL_SCHEME_PATTERN.test(unwrapped)) {
        continue;
      }

      const withoutAnchorOrQuery = unwrapped.split("#")[0]?.split("?")[0] ?? "";
      if (withoutAnchorOrQuery === "") {
        continue;
      }

      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(withoutAnchorOrQuery);
      } catch {
        errors.push(`${relFilePath}:${lineNumber}: Malformed URI in link "${unwrapped}".`);
        continue;
      }

      if (decodedTarget.startsWith("/") || decodedTarget.includes("\\")) {
        errors.push(
          `${relFilePath}:${lineNumber}: Link "${unwrapped}" must use forward-slash relative path without leading "/".`,
        );
        continue;
      }

      const resolvedTarget = resolve(baseDir, decodedTarget);
      const expectedCanonicalRel = relative(realRepoRoot, resolvedTarget).split(sep).join("/");
      const check = verifyExactRepoFile(realRepoRoot, resolvedTarget, expectedCanonicalRel);
      if (!check.valid) {
        errors.push(
          `${relFilePath}:${lineNumber}: Invalid relative link "${unwrapped}" (${check.reason}).`,
        );
      }
    }
  }
}

function checkMermaidBlocks(
  relFilePath: string,
  mermaidBlocks: ReadonlyArray<{ readonly startLine: number; readonly lines: readonly string[] }>,
  errors: string[],
): void {
  for (const block of mermaidBlocks) {
    const firstContentLine = block.lines
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("%%"));

    if (firstContentLine === undefined) {
      errors.push(`${relFilePath}:${block.startLine}: Empty mermaid code block.`);
      continue;
    }

    if (!ALLOWED_MERMAID_TYPES_PATTERN.test(firstContentLine)) {
      errors.push(
        `${relFilePath}:${block.startLine}: Unsupported Mermaid diagram declaration "${firstContentLine}".`,
      );
    }

    for (let offset = 0; offset < block.lines.length; offset += 1) {
      const line = block.lines[offset] ?? "";
      const lineNo = block.startLine + offset + 1;

      if (line.includes("\\n")) {
        errors.push(
          `${relFilePath}:${lineNo}: Mermaid block contains literal "\\n" (use single-line labels instead).`,
        );
      }

      if (MERMAID_HTML_TAG_PATTERN.test(line)) {
        errors.push(
          `${relFilePath}:${lineNo}: Mermaid block contains HTML tag (disallowed by visual formatting rules).`,
        );
      }
    }
  }
}

function checkHeadingsAndProhibitionBullets(
  realRepoRoot: string,
  relFilePath: string,
  proseLines: ReadonlyArray<{ readonly lineNumber: number; readonly text: string }>,
  implementedSlices: ReadonlySet<string>,
  errors: string[],
): number {
  let bulletCount = 0;

  for (const { lineNumber, text } of proseLines) {
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(text);
    if (headingMatch !== null) {
      const headingTitle = headingMatch[1] ?? "";
      if (BANNED_DOC_HEADING_PATTERN.test(headingTitle)) {
        errors.push(
          `${relFilePath}:${lineNumber}: Prohibited changelog/discussion heading "${headingTitle.trim()}".`,
        );
      }
    }

    if (!PROHIBITION_LINE_PATTERN.test(text)) {
      continue;
    }

    bulletCount += 1;
    const tagMatch = /（強制:\s*([^）]+?)）\s*$/.exec(text);
    if (tagMatch === null) {
      errors.push(
        `${relFilePath}:${lineNumber}: Prohibition guardrail is missing trailing "（強制: <file-path | S1〜S8予定 | Gate>）" tag.`,
      );
      continue;
    }

    const rawSegments = (tagMatch[1] ?? "").split(",");
    if (rawSegments.some((segment) => segment.trim() === "")) {
      errors.push(
        `${relFilePath}:${lineNumber}: Empty or trailing comma in enforcement tag "（強制: ...）".`,
      );
      continue;
    }

    const tokens = rawSegments.map((part) => part.trim().replace(/^`+|`+$/g, ""));

    for (const token of tokens) {
      if (token === "Gate") {
        continue;
      }

      const plannedMatch = PLANNED_SLICE_TOKEN_PATTERN.exec(token);
      if (plannedMatch !== null) {
        const sliceId = plannedMatch[1] ?? "";
        if (implementedSlices.has(sliceId)) {
          errors.push(
            `${relFilePath}:${lineNumber}: Enforcement target "${token}" references already-implemented slice ${sliceId}; replace with actual file path.`,
          );
        }
        continue;
      }

      const segments = token.split("/");
      if (
        !token.includes("\\") &&
        !segments.includes("..") &&
        !segments.includes(".") &&
        ALLOWED_REPO_PATH_TOKEN_PATTERN.test(token)
      ) {
        const resolvedTokenPath = resolve(realRepoRoot, token);
        const check = verifyExactRepoFile(realRepoRoot, resolvedTokenPath, token);
        if (!check.valid) {
          errors.push(
            `${relFilePath}:${lineNumber}: Enforcement target file "${token}" is invalid (${check.reason}).`,
          );
        }
        continue;
      }

      errors.push(
        `${relFilePath}:${lineNumber}: Invalid enforcement token "${token}" (expected normalized repo file path, S1〜S8予定, or Gate).`,
      );
    }
  }

  return bulletCount;
}

interface PlanStatusInfo {
  readonly implementedSlices: ReadonlySet<string>;
  readonly deployedSlices: ReadonlySet<string>;
  readonly museUnidentified: boolean;
}

const CODE_ONLY_UNDEPLOYED_PATTERN = /(?:コード実装済|デプロイ[^\s|]*(?:後|待)|未デプロイ)/;
const BLANKET_ALL_BOTS_CLAIM_PATTERN = /(?:4種類対応済|全\s*Bot\s*対応済|全経路対応済)/i;
const NEGATED_CLAIM_CONTEXT_PATTERN =
  /(?:表示しない|記載しない|対応済みにしない|数えない|保証しない|禁止|未実施|未確認)/;

function parsePlanStatusInfo(
  realRepoRoot: string,
  parsedPlan: ParsedMarkdown | undefined,
  errors: string[],
): PlanStatusInfo {
  const planPath = join(realRepoRoot, "docs", "implementation-plan.md");
  if (!existsSync(planPath) || parsedPlan === undefined) {
    errors.push("docs/implementation-plan.md:1: Missing required implementation plan document.");
    return {
      implementedSlices: new Set<string>(),
      deployedSlices: new Set<string>(),
      museUnidentified: false,
    };
  }

  const implemented = new Set<string>();
  const deployed = new Set<string>();
  const seenSlices = new Set<string>();
  let sliceColIndex = -1;
  let statusColIndex = -1;
  let museUnidentified = false;

  for (const { lineNumber, text } of parsedPlan.proseLines) {
    if (!text.trim().startsWith("|")) {
      continue;
    }
    const cells = splitMarkdownTableRow(text);
    if (cells.length < 2) {
      continue;
    }

    // Detect §4 Muse status row (e.g. | Muse の正式名称・URL | 未特定（`#19` 起票済） | ... |)
    if (cells.some((c) => /\bMuse\b/i.test(c)) && cells.some((c) => /未特定/.test(c))) {
      museUnidentified = true;
    }

    if (sliceColIndex === -1) {
      const foundSliceIdx = cells.findIndex((cell) => /^Slice$/i.test(cell));
      const foundStatusIdx = cells.findIndex((cell) => cell === "状態");
      if (foundSliceIdx !== -1 && foundStatusIdx !== -1) {
        sliceColIndex = foundSliceIdx;
        statusColIndex = foundStatusIdx;
      }
      continue;
    }

    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      continue;
    }

    const sliceCell = cells[sliceColIndex] ?? "";
    const sliceMatch = /^\*{0,2}(S[0-8])\*{0,2}\b/.exec(sliceCell);
    if (sliceMatch === null) {
      sliceColIndex = -1;
      statusColIndex = -1;
      continue;
    }

    const sliceId = sliceMatch[1] ?? "";
    const statusCell = cells[statusColIndex] ?? "";
    seenSlices.add(sliceId);

    if (/(?:実装済|検証済|完了)/.test(statusCell) && !/(?:未着手|未実装)/.test(statusCell)) {
      implemented.add(sliceId);
      if (!CODE_ONLY_UNDEPLOYED_PATTERN.test(statusCell)) {
        deployed.add(sliceId);
      }
    } else if (!/(?:未着手|未実装)/.test(statusCell)) {
      errors.push(
        `docs/implementation-plan.md:${lineNumber}: Unrecognized status "${statusCell}" for slice ${sliceId}.`,
      );
    }
  }

  for (const expectedSlice of EXPECTED_ALL_SLICES) {
    if (!seenSlices.has(expectedSlice)) {
      errors.push(
        `docs/implementation-plan.md:1: Slice table is missing required row for "${expectedSlice}".`,
      );
    }
  }

  return {
    implementedSlices: implemented,
    deployedSlices: deployed,
    museUnidentified,
  };
}

function checkUnverifiedBotStatusClaims(
  parsedBotDoc: ParsedMarkdown | undefined,
  parsedByRelPath: ReadonlyMap<string, ParsedMarkdown>,
  planStatus: PlanStatusInfo,
  errors: string[],
): void {
  if (parsedBotDoc === undefined) {
    errors.push("docs/bot-integration.md:1: Missing required bot integration document.");
    return;
  }

  let channelColIndex = -1;
  let statusColIndex = -1;
  let verifiedTableRows = 0;
  let hasUnverifiedChannel = false;

  for (const { lineNumber, text } of parsedBotDoc.proseLines) {
    if (!text.trim().startsWith("|")) {
      if (channelColIndex !== -1 && verifiedTableRows > 0) {
        channelColIndex = -1;
        statusColIndex = -1;
      }
      continue;
    }

    const cells = splitMarkdownTableRow(text);
    if (channelColIndex === -1) {
      const foundChannelIdx = cells.findIndex((cell) => cell === "経路");
      const foundStatusIdx = cells.findIndex((cell) => cell === "現在");
      if (foundChannelIdx !== -1 && foundStatusIdx !== -1) {
        channelColIndex = foundChannelIdx;
        statusColIndex = foundStatusIdx;
      }
      continue;
    }

    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      continue;
    }

    verifiedTableRows += 1;
    const channelName = cells[channelColIndex] ?? "";
    const currentStatus = cells[statusColIndex] ?? "";

    if (currentStatus === "未実施" || currentStatus === "未特定") {
      hasUnverifiedChannel = true;
    }

    if (
      planStatus.museUnidentified &&
      /\bMuse\b/i.test(channelName) &&
      currentStatus !== "未特定"
    ) {
      errors.push(
        `docs/bot-integration.md:${lineNumber}: Channel "${channelName}" must remain "未特定" while Muse is unidentified in docs/implementation-plan.md (found "${currentStatus}").`,
      );
    }

    if (!planStatus.deployedSlices.has("S4")) {
      if (currentStatus !== "未実施" && currentStatus !== "未特定") {
        errors.push(
          `docs/bot-integration.md:${lineNumber}: Channel "${channelName}" has status "${currentStatus}" before Slice S4 is implemented and deployed (must be 未実施 or 未特定).`,
        );
      }
    } else if (!planStatus.implementedSlices.has("S8") && /(?:対応済)/.test(currentStatus)) {
      errors.push(
        `docs/bot-integration.md:${lineNumber}: Channel "${channelName}" cannot be marked 対応済 before Slice S8 end-to-end verification.`,
      );
    }
  }

  if (verifiedTableRows < 4) {
    errors.push(
      "docs/bot-integration.md:1: Missing or incomplete Bot verification status table (expected >= 4 channel rows).",
    );
  }

  if (hasUnverifiedChannel || !planStatus.deployedSlices.has("S4")) {
    for (const [relPath, parsed] of parsedByRelPath) {
      for (const { lineNumber, text } of parsed.proseLines) {
        if (PROHIBITION_LINE_PATTERN.test(text)) {
          continue;
        }
        const sanitized = stripInlineCodeSpans(text);
        if (
          BLANKET_ALL_BOTS_CLAIM_PATTERN.test(sanitized) &&
          !NEGATED_CLAIM_CONTEXT_PATTERN.test(sanitized)
        ) {
          errors.push(
            `${relPath}:${lineNumber}: Premature blanket Bot support claim while unverified channels remain in docs/bot-integration.md §8.`,
          );
        }
      }
    }
  }
}

function extractAcIdsFromText(text: string): string[] {
  const results = new Set<string>();

  // Expand shorthand ranges like `UX-01`〜`05` or DEC-01~04
  const rangePattern = /`?(UX|DEC|BOT)-(\d{2})`?\s*[〜~\-–]\s*`?(?:(?:UX|DEC|BOT)-)?(\d{2})`?/g;
  for (const match of text.matchAll(rangePattern)) {
    const prefix = match[1];
    const startNum = Number(match[2]);
    const endNum = Number(match[3]);
    if (prefix !== undefined && Number.isInteger(startNum) && Number.isInteger(endNum)) {
      const low = Math.min(startNum, endNum);
      const high = Math.max(startNum, endNum);
      for (let n = low; n <= high; n += 1) {
        results.add(`${prefix}-${String(n).padStart(2, "0")}`);
      }
    }
  }

  const singlePattern = /\b(UX|DEC|BOT)-(\d{2})\b/g;
  for (const match of text.matchAll(singlePattern)) {
    const prefix = match[1];
    const num = match[2];
    if (prefix !== undefined && num !== undefined) {
      results.add(`${prefix}-${num}`);
    }
  }

  return [...results];
}

function checkImplementationPlanAcConsistency(
  parsedPlan: ParsedMarkdown | undefined,
  errors: string[],
): void {
  if (parsedPlan === undefined) {
    return;
  }

  const sliceClaims: Array<{
    readonly lineNumber: number;
    readonly sliceId: string;
    readonly acIds: readonly string[];
  }> = [];

  let sliceColIndex = -1;
  let verificationColIndex = -1;

  for (const { lineNumber, text } of parsedPlan.proseLines) {
    if (!text.trim().startsWith("|")) {
      continue;
    }
    const cells = splitMarkdownTableRow(text);
    if (cells.length < 2) {
      continue;
    }

    if (sliceColIndex === -1) {
      const foundSliceIdx = cells.findIndex((cell) => /^Slice$/i.test(cell));
      const foundVerifIdx = cells.findIndex((cell) => cell.includes("検証"));
      if (foundSliceIdx !== -1 && foundVerifIdx !== -1) {
        sliceColIndex = foundSliceIdx;
        verificationColIndex = foundVerifIdx;
      }
      continue;
    }

    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      continue;
    }

    const sliceCell = cells[sliceColIndex] ?? "";
    const sliceMatch = /^\*{0,2}(S[0-8])\*{0,2}\b/.exec(sliceCell);
    if (sliceMatch === null) {
      sliceColIndex = -1;
      verificationColIndex = -1;
      continue;
    }

    const sliceId = sliceMatch[1] ?? "";
    const verificationCell = cells[verificationColIndex] ?? "";
    const acIds = extractAcIdsFromText(verificationCell);
    if (acIds.length > 0) {
      sliceClaims.push({ lineNumber, sliceId, acIds });
    }
  }

  if (sliceClaims.length === 0) {
    return;
  }

  const traceByAcId = new Map<string, Set<string>>();
  let acColIndex = -1;
  let implSliceColIndex = -1;
  let finalE2eColIndex = -1;

  for (const { text } of parsedPlan.proseLines) {
    if (!text.trim().startsWith("|")) {
      continue;
    }
    const cells = splitMarkdownTableRow(text);
    if (cells.length < 3) {
      continue;
    }

    if (acColIndex === -1) {
      const foundAcIdx = cells.findIndex((cell) => /^AC\s*ID$/i.test(cell));
      const foundImplIdx = cells.findIndex((cell) => cell.includes("実装スライス"));
      const foundFinalIdx = cells.findIndex((cell) => cell.includes("最終E2E"));
      if (foundAcIdx !== -1 && foundImplIdx !== -1) {
        acColIndex = foundAcIdx;
        implSliceColIndex = foundImplIdx;
        finalE2eColIndex = foundFinalIdx;
      }
      continue;
    }

    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      continue;
    }

    const acCell = cells[acColIndex] ?? "";
    const acMatch = /`?((?:UX|DEC|BOT)-\d{2})`?/.exec(acCell);
    if (acMatch === null) {
      acColIndex = -1;
      implSliceColIndex = -1;
      finalE2eColIndex = -1;
      continue;
    }

    const acId = acMatch[1] ?? "";
    const combinedSlicesText = `${cells[implSliceColIndex] ?? ""} ${finalE2eColIndex !== -1 ? (cells[finalE2eColIndex] ?? "") : ""}`;
    const slices = new Set<string>();
    for (const match of combinedSlicesText.matchAll(/\b(S[0-8])\b/g)) {
      const s = match[1];
      if (s !== undefined) {
        slices.add(s);
      }
    }
    traceByAcId.set(acId, slices);
  }

  for (const claim of sliceClaims) {
    for (const acId of claim.acIds) {
      const tracedSlices = traceByAcId.get(acId);
      if (tracedSlices === undefined) {
        errors.push(
          `docs/implementation-plan.md:${claim.lineNumber}: Slice ${claim.sliceId} references AC "${acId}", which is missing from the AC trace table.`,
        );
      } else if (!tracedSlices.has(claim.sliceId)) {
        errors.push(
          `docs/implementation-plan.md:${claim.lineNumber}: Slice ${claim.sliceId} claims AC "${acId}" in §2, but §3 AC trace table does not list ${claim.sliceId} under "${acId}".`,
        );
      }
    }
  }
}

export function validateRepositoryGuardrails(repoRoot: string): GuardrailCheckReport {
  const realRepoRoot = realpathSync.native(resolve(repoRoot));
  const errors: string[] = [];

  const rootMarkdownFiles: string[] = [];
  for (const rootDocName of ["README.md", "AGENTS.md"]) {
    const candidate = join(realRepoRoot, rootDocName);
    if (!existsSync(candidate)) {
      continue;
    }
    if (lstatSync(candidate).isSymbolicLink()) {
      errors.push(`${rootDocName}:1: Symbolic links are disallowed for root documentation.`);
      continue;
    }
    rootMarkdownFiles.push(candidate);
  }

  const docsMarkdownFiles = collectMarkdownFiles(realRepoRoot, join(realRepoRoot, "docs"), errors);
  const allMarkdownFiles = [...rootMarkdownFiles, ...docsMarkdownFiles];

  const parsedByRelPath = new Map<string, ParsedMarkdown>();
  for (const absFilePath of allMarkdownFiles) {
    const relFilePath = relative(realRepoRoot, absFilePath).split(sep).join("/");
    const content = readFileSync(absFilePath, "utf8");
    parsedByRelPath.set(relFilePath, parseMarkdownFences(relFilePath, content, errors));
  }

  const planStatus = parsePlanStatusInfo(
    realRepoRoot,
    parsedByRelPath.get("docs/implementation-plan.md"),
    errors,
  );
  checkImplementationPlanAcConsistency(parsedByRelPath.get("docs/implementation-plan.md"), errors);

  let checkedProhibitionBullets = 0;

  for (const absFilePath of allMarkdownFiles) {
    const relFilePath = relative(realRepoRoot, absFilePath).split(sep).join("/");
    const parsed = parsedByRelPath.get(relFilePath);
    if (parsed === undefined) {
      continue;
    }

    checkRelativeLinks(realRepoRoot, absFilePath, relFilePath, parsed.proseLines, errors);
    checkMermaidBlocks(relFilePath, parsed.mermaidBlocks, errors);
    checkedProhibitionBullets += checkHeadingsAndProhibitionBullets(
      realRepoRoot,
      relFilePath,
      parsed.proseLines,
      planStatus.implementedSlices,
      errors,
    );
  }

  checkUnverifiedBotStatusClaims(
    parsedByRelPath.get("docs/bot-integration.md"),
    parsedByRelPath,
    planStatus,
    errors,
  );

  return {
    ok: errors.length === 0,
    errors,
    checkedMarkdownFiles: allMarkdownFiles.length,
    checkedProhibitionBullets,
  };
}
