import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const BANNED_PACKAGES = [
  "prettier",
  "eslint",
  "@biomejs/biome",
  "biome",
  "oxlint",
  "vitest",
  "jest",
  "ts-node",
  "tsx",
  "husky",
  "lint-staged",
] as const;

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsSingletonOrMutableModuleState(relativePath: string, content: string): boolean {
  const topLevelFactoryAssignmentPattern =
    /^(?:export\s+)?(?:default\s+|(?:const|let|var)\s+[^=;]+=\s*)(?:betterAuth|drizzle)\s*(?:<[^\n;]*>)?\s*\(/m;
  if (topLevelFactoryAssignmentPattern.test(content)) {
    return true;
  }

  if (relativePath.startsWith("src/auth/") || relativePath.startsWith("src/db/")) {
    const topLevelMutableBindingPattern = /^(?:export\s+)?(?:let|var)\s+\w+/m;
    if (topLevelMutableBindingPattern.test(content)) {
      return true;
    }
  }

  return false;
}

describe("repository mechanical guardrails", () => {
  test("package.json excludes external formatters, linters, and test runners", async () => {
    const raw = await Bun.file(join(REPO_ROOT, "package.json")).text();
    const parsed: unknown = JSON.parse(raw);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) {
      return;
    }

    const pkg: PackageJsonShape = parsed;
    const allDeps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    for (const banned of BANNED_PACKAGES) {
      expect(allDeps.has(banned)).toBe(false);
    }
  });

  test("singleton detector catches generic, typed, export-default, and lazy-let singletons", () => {
    expect(
      containsSingletonOrMutableModuleState(
        "src/db/client.ts",
        "export const db = drizzle<typeof schema>(env.DB);\n",
      ),
    ).toBe(true);
    expect(
      containsSingletonOrMutableModuleState(
        "src/auth/server.ts",
        "export const auth: AuthInstance = betterAuth({});\n",
      ),
    ).toBe(true);
    expect(
      containsSingletonOrMutableModuleState(
        "src/auth/server.ts",
        "export default betterAuth({});\n",
      ),
    ).toBe(true);
    expect(
      containsSingletonOrMutableModuleState(
        "src/db/lazy.ts",
        "let cachedDb: unknown = undefined;\n",
      ),
    ).toBe(true);
    expect(
      containsSingletonOrMutableModuleState(
        "src/db/factory.ts",
        "export function createDb(d1: unknown) {\n  return drizzle(d1);\n}\n",
      ),
    ).toBe(false);
  });

  test("src/ contains zero module-scope betterAuth()/drizzle() singletons or mutable auth/db state", async () => {
    const glob = new Bun.Glob("src/**/*.{ts,tsx}");

    for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
      const content = await Bun.file(join(REPO_ROOT, relativePath)).text();
      expect(containsSingletonOrMutableModuleState(relativePath, content)).toBe(false);
    }
  });

  test("bun lint enforces relative/@/* zones, capability entrypoints, subpath bans, ban-ts-comment, and globals", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bot-board-lint-guard-"));

    try {
      const bunfigContent = await Bun.file(join(REPO_ROOT, "bunfig.toml")).text();
      const tsconfigContent = await Bun.file(join(REPO_ROOT, "tsconfig.json")).text();
      writeFileSync(join(tempRoot, "bunfig.toml"), bunfigContent);
      writeFileSync(join(tempRoot, "tsconfig.json"), tsconfigContent);
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "lint-fixture", private: true, type: "module" }),
      );

      const dirs = [
        "src/domain",
        "src/db",
        "src/client",
        "src/server/routes/human",
        "src/server/routes/mcp",
        "src/services/human",
        "src/services/bot",
        "src/services/system",
        "src/adapters",
        "src/worker",
        "src/auth/internal",
        "scripts",
        "node_modules/better-auth",
        "node_modules/@better-auth/mcp",
        "node_modules/drizzle-orm",
      ];
      for (const dir of dirs) {
        mkdirSync(join(tempRoot, dir), { recursive: true });
      }

      writeFileSync(join(tempRoot, "src/db/index.ts"), "export const dbToken = 1;\n");
      writeFileSync(
        join(tempRoot, "src/server/routes/human/index.ts"),
        "export const route = 1;\n",
      );
      writeFileSync(join(tempRoot, "src/services/human/index.ts"), "export const humanOp = 1;\n");
      writeFileSync(join(tempRoot, "src/auth/internal/mint.ts"), "export const secretMint = 1;\n");
      writeFileSync(join(tempRoot, "src/auth/owner.ts"), "export const verifyOwner = 1;\n");
      writeFileSync(join(tempRoot, "src/auth/bot.ts"), "export const verifyBot = 1;\n");
      writeFileSync(join(tempRoot, "scripts/helper.ts"), "export const tool = 1;\n");
      writeFileSync(
        join(tempRoot, "node_modules/better-auth/minimal.d.ts"),
        "export declare function betterAuth(): { readonly ok: true };\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/better-auth/minimal.js"),
        "export const betterAuth = () => ({ ok: true });\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/@better-auth/mcp/index.d.ts"),
        "export declare function mcp(): { readonly ok: true };\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/@better-auth/mcp/index.js"),
        "export const mcp = () => ({ ok: true });\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/drizzle-orm/d1.d.ts"),
        "export declare function drizzle(): { readonly ok: true };\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/drizzle-orm/d1.js"),
        "export const drizzle = () => ({ ok: true });\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/drizzle-orm/bun-sqlite.d.ts"),
        "export declare function drizzleSqlite(): { readonly ok: true };\n",
      );
      writeFileSync(
        join(tempRoot, "node_modules/drizzle-orm/bun-sqlite.js"),
        "export const drizzleSqlite = () => ({ ok: true });\n",
      );

      const rejectedCases: ReadonlyArray<{
        readonly file: string;
        readonly code: string;
        readonly expectedRule: string;
      }> = [
        {
          file: "src/domain/bad-alias.ts",
          code: 'import { dbToken } from "@/db";\nexport const x = dbToken;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/client/bad-server.ts",
          code: 'import { route } from "@/server/routes/human";\nexport const x = route;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/server/app-db.ts",
          code: 'import { dbToken } from "@/db";\nexport const x = dbToken;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/services/bot/bad-human.ts",
          code: 'import { humanOp } from "@/services/human";\nexport const x = humanOp;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/services/system/bad-human.ts",
          code: 'import { humanOp } from "@/services/human";\nexport const x = humanOp;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/server/routes/mcp/bad-owner-auth.ts",
          code: 'import { verifyOwner } from "@/auth/owner.ts";\nexport const x = verifyOwner;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/services/bot/bad-bot-mint.ts",
          code: 'import { verifyBot } from "@/auth/bot.ts";\nexport const x = verifyBot;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/services/bot/bad-upward-route.ts",
          code: 'import { route } from "@/server/routes/human";\nexport const x = route;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/services/bot/bad-auth-subpath.ts",
          code: 'import { betterAuth } from "better-auth/minimal";\nexport const x = betterAuth;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "src/db/bad-auth-in-db.ts",
          code: 'import { betterAuth } from "better-auth/minimal";\nexport const x = betterAuth;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "src/auth/bad-d1-in-auth.ts",
          code: 'import { drizzle } from "drizzle-orm/d1";\nexport const x = drizzle;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "src/services/bot/bad-sqlite-driver.ts",
          code: 'import { drizzleSqlite } from "drizzle-orm/bun-sqlite";\nexport const x = drizzleSqlite;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "src/services/bot/cast.ts",
          code: 'export const forged = ({ id: "1" } as { id: string });\n',
          expectedRule: "consistent-type-assertions",
        },
        {
          file: "src/services/bot/ts-expect-bypass.ts",
          code: "// @ts-expect-error -- attempted bypass in production code\nexport const broken: string = 123;\n",
          expectedRule: "ban-ts-comment",
        },
        {
          file: "src/domain/global-leak.ts",
          code: "export const ver = Bun.version;\n",
          expectedRule: "no-restricted-globals",
        },
        {
          file: "src/domain/log.ts",
          code: 'console.log("secret");\n',
          expectedRule: "no-console",
        },
        {
          file: "scripts/bad-net.ts",
          code: 'export const p = fetch("https://example.com");\n',
          expectedRule: "no-restricted-globals",
        },
        {
          file: "scripts/bad-bun-global.ts",
          code: "export const ver = Bun.version;\n",
          expectedRule: "no-restricted-globals",
        },
        {
          file: "scripts/bad-random.ts",
          code: "export const r = Math.random();\n",
          expectedRule: "no-restricted-properties",
        },
        {
          file: "scripts/bad-dns.ts",
          code: 'import { lookup } from "node:dns/promises";\nexport const fn = lookup;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "scripts/bad-auth-in-scripts.ts",
          code: 'import { betterAuth } from "better-auth/minimal";\nexport const fn = betterAuth;\n',
          expectedRule: "no-restricted-imports",
        },
        {
          file: "scripts/bad-src-import.ts",
          code: 'import { dbToken } from "../src/db/index.ts";\nexport const x = dbToken;\n',
          expectedRule: "import/no-restricted-paths",
        },
        {
          file: "src/domain/bad-scripts-import.ts",
          code: 'import { tool } from "../../scripts/helper.ts";\nexport const x = tool;\n',
          expectedRule: "import/no-restricted-paths",
        },
      ];

      for (const testCase of rejectedCases) {
        const targetPath = join(tempRoot, testCase.file);
        writeFileSync(targetPath, testCase.code);

        const result = Bun.spawnSync([process.execPath, "lint", "--no-script", testCase.file], {
          cwd: tempRoot,
          stderr: "pipe",
          stdout: "pipe",
        });

        const combinedOutput =
          new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

        expect(result.exitCode).toBe(1);
        expect(combinedOutput).toContain(testCase.expectedRule);

        rmSync(targetPath);
      }

      const allowedCases: ReadonlyArray<{
        readonly file: string;
        readonly code: string;
      }> = [
        {
          file: "src/db/allowed-d1.ts",
          code: 'import { drizzle } from "drizzle-orm/d1";\nexport function createD1() {\n  return drizzle();\n}\n',
        },
        {
          file: "src/auth/allowed-better-auth.ts",
          code: 'import { betterAuth } from "better-auth/minimal";\nexport function createAuth() {\n  return betterAuth();\n}\n',
        },
      ];

      for (const allowedCase of allowedCases) {
        const targetPath = join(tempRoot, allowedCase.file);
        writeFileSync(targetPath, allowedCase.code);

        const result = Bun.spawnSync([process.execPath, "lint", "--no-script", allowedCase.file], {
          cwd: tempRoot,
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).toBe(0);
        rmSync(targetPath);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
