import { describe, expect, test } from "bun:test";

import {
  buildPulumiCommandEnv,
  isSelfHostedPulumiBackend,
  redactSecretFromText,
  runPulumiLogin,
} from "../../../infra/deploy";

describe("Pulumi deploy secret & backend hardening (infra/deploy.ts)", () => {
  test("strips empty PULUMI_* and AWS_* keys so Pulumi os.LookupEnv never sees empty passphrase", () => {
    const sanitized = buildPulumiCommandEnv({
      PATH: "/usr/bin",
      CLOUDFLARE_API_TOKEN: "cf-tok",
      PULUMI_ACCESS_TOKEN: "pul-123",
      PULUMI_BACKEND_URL: "",
      PULUMI_CONFIG_PASSPHRASE: "",
      PULUMI_CONFIG_PASSPHRASE_FILE: "   ",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "  ",
    });

    expect(sanitized["PULUMI_ACCESS_TOKEN"]).toBe("pul-123");
    expect("PULUMI_BACKEND_URL" in sanitized).toBe(false);
    expect("PULUMI_CONFIG_PASSPHRASE" in sanitized).toBe(false);
    expect("PULUMI_CONFIG_PASSPHRASE_FILE" in sanitized).toBe(false);
    expect("AWS_ACCESS_KEY_ID" in sanitized).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in sanitized).toBe(false);
  });

  test("fails closed when a self-hosted PULUMI_BACKEND_URL is configured without a non-empty passphrase", () => {
    for (const backendUrl of [
      "s3://bot-board-state?endpoint=r2.example.com",
      "file://~/.pulumi",
      "gs://bot-board-state",
      "azblob://bot-board-state",
    ]) {
      expect(isSelfHostedPulumiBackend(backendUrl)).toBe(true);
      expect(() =>
        buildPulumiCommandEnv({
          PULUMI_BACKEND_URL: backendUrl,
          PULUMI_CONFIG_PASSPHRASE: "",
        }),
      ).toThrow("PULUMI_CONFIG_PASSPHRASE");
      expect(() =>
        buildPulumiCommandEnv({
          PULUMI_BACKEND_URL: backendUrl,
        }),
      ).toThrow("PULUMI_CONFIG_PASSPHRASE");

      const okWithPassphrase = buildPulumiCommandEnv({
        PULUMI_BACKEND_URL: backendUrl,
        PULUMI_CONFIG_PASSPHRASE: "strong-secret-passphrase",
      });
      expect(okWithPassphrase["PULUMI_BACKEND_URL"]).toBe(backendUrl);
      expect(okWithPassphrase["PULUMI_CONFIG_PASSPHRASE"]).toBe("strong-secret-passphrase");
    }

    // Hosted HTTP(S) Pulumi Cloud API URL does not require a local passphrase
    expect(isSelfHostedPulumiBackend("https://api.pulumi.com")).toBe(false);
    const cloudEnv = buildPulumiCommandEnv({
      PULUMI_BACKEND_URL: "https://api.pulumi.com",
      PULUMI_ACCESS_TOKEN: "pul-cloud-token",
      PULUMI_CONFIG_PASSPHRASE: "",
    });
    expect("PULUMI_CONFIG_PASSPHRASE" in cloudEnv).toBe(false);
  });

  test("runPulumiLogin never passes PULUMI_BACKEND_URL in argv and redacts URLs on failure", () => {
    const secretBackendUrl =
      "s3://my-bucket?endpoint=https://acct.r2.cloudflarestorage.com&awssdk=v2&token=super-secret-sas";
    const env = buildPulumiCommandEnv({
      PULUMI_BACKEND_URL: secretBackendUrl,
      PULUMI_CONFIG_PASSPHRASE: "valid-passphrase",
    });

    const seen: { cmd: readonly string[]; envUrl: string | undefined } = {
      cmd: [],
      envUrl: undefined,
    };

    runPulumiLogin("/usr/local/bin/pulumi", "/tmp/infra", env, (cmd, opts) => {
      seen.cmd = cmd;
      seen.envUrl = opts.env["PULUMI_BACKEND_URL"];
      return { exitCode: 0, stderrText: "" };
    });

    expect(seen.cmd).toEqual(["/usr/local/bin/pulumi", "login", "--non-interactive"]);
    expect(seen.cmd.join(" ")).not.toContain(secretBackendUrl);
    expect(seen.envUrl).toBe(secretBackendUrl);

    let thrownMessage = "";
    try {
      runPulumiLogin("/usr/local/bin/pulumi", "/tmp/infra", env, () => ({
        exitCode: 1,
        stderrText: `error: failed to log in to ${secretBackendUrl} via https://acct.r2.cloudflarestorage.com`,
      }));
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toContain("pulumi login --non-interactive");
    expect(thrownMessage).not.toContain("super-secret-sas");
    expect(thrownMessage).not.toContain("my-bucket");
    expect(redactSecretFromText(`failed at ${secretBackendUrl}`, secretBackendUrl)).not.toContain(
      "super-secret-sas",
    );
  });
});
