import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { jwt } from "better-auth/plugins";

import { BOT_SCOPES } from "@/domain";

export interface ExpectedAuthFieldContract {
  readonly columnName: string;
  readonly required: boolean;
  readonly unique: boolean;
}

export interface ExpectedAuthTableContract {
  readonly modelName: string;
  readonly fields: ReadonlyMap<string, ExpectedAuthFieldContract>;
}

/**
 * Computes the expected Better Auth + JWT + @better-auth/passkey + @better-auth/mcp table/column contract
 * dynamically (request/test-scoped, zero module-level singletons) so schema parity
 * guardrails stay locked to the installed Better Auth version.
 */
export function inspectBetterAuthSchemaContract(): ReadonlyMap<string, ExpectedAuthTableContract> {
  const probeAuth = betterAuth({
    baseURL: "https://schema-probe.invalid",
    secret: "schema-probe-entropy-0123456789-abcdef",
    plugins: [
      jwt(),
      passkey(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: "https://schema-probe.invalid/api/mcp",
        allowDynamicClientRegistration: true,
        scopes: ["openid", "profile", "email", "offline_access", ...BOT_SCOPES],
      }),
    ],
  });

  const tables = getAuthTables(probeAuth.options);
  const result = new Map<string, ExpectedAuthTableContract>();

  for (const [, def] of Object.entries(tables)) {
    const fields = new Map<string, ExpectedAuthFieldContract>();
    for (const [fieldKey, fieldDef] of Object.entries(def.fields)) {
      const columnName = fieldDef.fieldName ?? fieldKey;
      fields.set(columnName, {
        columnName,
        required: fieldDef.required === true,
        unique: fieldDef.unique === true,
      });
    }
    result.set(def.modelName, {
      modelName: def.modelName,
      fields,
    });
  }

  return result;
}
