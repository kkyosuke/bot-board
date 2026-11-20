import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("bot-board");
const stack = pulumi.getStack();

const accountId = config.require("accountId");
const appEnv = config.get("appEnv") ?? stack;
const betterAuthUrl = config.require("betterAuthUrl");
const trustedOrigins = config.get("trustedOrigins") ?? betterAuthUrl;
const ownerGithubId = config.require("ownerGithubId");

const betterAuthSecret = config.requireSecret("betterAuthSecret");
const githubClientId = config.requireSecret("githubClientId");
const githubClientSecret = config.requireSecret("githubClientSecret");
const xaiApiKey = config.getSecret("xaiApiKey");

const rateLimitRequests = config.getNumber("rateLimitRequests") ?? 120;
const rateLimitPeriodSeconds = config.getNumber("rateLimitPeriodSeconds") ?? 60;
const rateLimitNamespaceId = config.require("rateLimitNamespaceId");
const workerCpuMsLimit = config.getNumber("workerCpuMsLimit") ?? 50;

const zoneId = config.get("zoneId");
const hostname = config.get("hostname");
const routePattern = config.get("routePattern");

const namePrefix = `bot-board-${stack}`;
const workerBundlePath = resolve(import.meta.dir, "..", "dist", "worker", "index.js");
const clientAssetsDir = resolve(import.meta.dir, "..", "dist", "client");

function computeWorkerSha256(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(
      `Built worker bundle not found at ${filePath}. Run "bun run build && bun run build:worker" before Pulumi deploy.`,
    );
  }
  const contents = readFileSync(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

function assertClientAssetsExist(assetsDir: string): string {
  const indexHtmlPath = resolve(assetsDir, "index.html");
  if (!existsSync(indexHtmlPath)) {
    throw new Error(
      `Built client assets not found at ${indexHtmlPath}. Run "bun run build" before Pulumi deploy.`,
    );
  }
  return assetsDir;
}

// 1. Cloudflare D1 Database (Better Auth + Domain Tables)
const database = new cloudflare.D1Database("bot-board-db", {
  accountId,
  name: `${namePrefix}-db`,
  primaryLocationHint: "apac",
});

// 2. Cloudflare Queues (decision-finalize / bot-work / bot-work-dlq)
const decisionFinalizeQueue = new cloudflare.Queue("decision-finalize-queue", {
  accountId,
  queueName: `${namePrefix}-decision-finalize`,
  settings: {
    deliveryDelay: 5,
  },
});

const botWorkDlq = new cloudflare.Queue("bot-work-dlq", {
  accountId,
  queueName: `${namePrefix}-bot-work-dlq`,
});

const botWorkQueue = new cloudflare.Queue("bot-work-queue", {
  accountId,
  queueName: `${namePrefix}-bot-work`,
});

// 3. Worker Bindings (Assets + D1 + Queues + Rate Limiting + Plain/Secret Env)
const workerBindings: pulumi.Input<cloudflare.types.input.WorkersScriptBinding>[] = [
  {
    type: "assets",
    name: "ASSETS",
  },
  {
    type: "d1",
    name: "DB",
    id: database.id,
  },
  {
    type: "queue",
    name: "DECISION_FINALIZE_QUEUE",
    queueName: decisionFinalizeQueue.queueName,
  },
  {
    type: "queue",
    name: "BOT_WORK_QUEUE",
    queueName: botWorkQueue.queueName,
  },
  {
    type: "queue",
    name: "BOT_WORK_DLQ",
    queueName: botWorkDlq.queueName,
  },
  {
    type: "ratelimit",
    name: "API_RATE_LIMITER",
    namespaceId: rateLimitNamespaceId,
    simple: {
      limit: rateLimitRequests,
      period: rateLimitPeriodSeconds,
    },
  },
  {
    type: "plain_text",
    name: "APP_ENV",
    text: appEnv,
  },
  {
    type: "plain_text",
    name: "BETTER_AUTH_URL",
    text: betterAuthUrl,
  },
  {
    type: "plain_text",
    name: "TRUSTED_ORIGINS",
    text: trustedOrigins,
  },
  {
    type: "plain_text",
    name: "OWNER_GITHUB_ID",
    text: ownerGithubId,
  },
  {
    type: "secret_text",
    name: "BETTER_AUTH_SECRET",
    text: betterAuthSecret,
  },
  {
    type: "secret_text",
    name: "GITHUB_CLIENT_ID",
    text: githubClientId,
  },
  {
    type: "secret_text",
    name: "GITHUB_CLIENT_SECRET",
    text: githubClientSecret,
  },
];

if (xaiApiKey !== undefined) {
  workerBindings.push({
    type: "secret_text",
    name: "XAI_API_KEY",
    text: xaiApiKey,
  });
}

// 4. Cloudflare Worker (Static Assets SPA + Hono API + MCP + Queue/Cron)
const workerScript = new cloudflare.WorkersScript("bot-board-worker", {
  accountId,
  scriptName: namePrefix,
  mainModule: "index.js",
  contentFile: workerBundlePath,
  contentSha256: computeWorkerSha256(workerBundlePath),
  compatibilityDate: "2026-11-01",
  compatibilityFlags: ["nodejs_compat"],
  limits: {
    cpuMs: workerCpuMsLimit,
  },
  assets: {
    directory: assertClientAssetsExist(clientAssetsDir),
    config: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/.well-known/*"],
    },
  },
  bindings: workerBindings,
});

// 5. Cloudflare Queue Consumers (isolated batchSize / maxRetries / DLQ)
const decisionFinalizeConsumer = new cloudflare.QueueConsumer("decision-finalize-consumer", {
  accountId,
  queueId: decisionFinalizeQueue.queueId,
  type: "worker",
  scriptName: workerScript.scriptName,
  settings: {
    batchSize: 10,
    maxRetries: 5,
    maxWaitTimeMs: 1000,
    retryDelay: 5,
  },
});

const botWorkConsumer = new cloudflare.QueueConsumer("bot-work-consumer", {
  accountId,
  queueId: botWorkQueue.queueId,
  type: "worker",
  scriptName: workerScript.scriptName,
  deadLetterQueue: botWorkDlq.queueName,
  settings: {
    batchSize: 1,
    maxRetries: 3,
    maxWaitTimeMs: 1000,
    retryDelay: 15,
  },
});

const botWorkDlqConsumer = new cloudflare.QueueConsumer("bot-work-dlq-consumer", {
  accountId,
  queueId: botWorkDlq.queueId,
  type: "worker",
  scriptName: workerScript.scriptName,
  settings: {
    batchSize: 5,
    maxRetries: 1,
    maxWaitTimeMs: 1000,
  },
});

// 6. Cloudflare Workers Cron Trigger (1-minute sweep)
const cronTrigger = new cloudflare.WorkersCronTrigger("bot-board-cron", {
  accountId,
  scriptName: workerScript.scriptName,
  schedules: [{ cron: "* * * * *" }],
});

// 7. Optional Custom Domain or Route (HTTPS public entrypoint for MCP & OAuth)
const customDomain =
  zoneId !== undefined && hostname !== undefined
    ? new cloudflare.WorkersCustomDomain("bot-board-domain", {
        accountId,
        zoneId,
        hostname,
        service: workerScript.scriptName,
        enabled: true,
      })
    : undefined;

const workersRoute =
  zoneId !== undefined && routePattern !== undefined && customDomain === undefined
    ? new cloudflare.WorkersRoute("bot-board-route", {
        zoneId,
        pattern: routePattern,
        script: workerScript.scriptName,
      })
    : undefined;

export const d1DatabaseId = database.id;
export const d1DatabaseName = database.name;
export const workerName = workerScript.scriptName;
export const decisionFinalizeQueueId = decisionFinalizeQueue.queueId;
export const botWorkQueueId = botWorkQueue.queueId;
export const botWorkDlqId = botWorkDlq.queueId;
export const decisionFinalizeConsumerId = decisionFinalizeConsumer.consumerId;
export const botWorkConsumerId = botWorkConsumer.consumerId;
export const botWorkDlqConsumerId = botWorkDlqConsumer.consumerId;
export const cronTriggerId = cronTrigger.id;
export const customDomainId = customDomain?.id;
export const routeId = workersRoute?.id;
