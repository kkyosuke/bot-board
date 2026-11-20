import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

function resolveChromiumExecutablePath(): string | undefined {
  if (process.env["CI"] === "true") {
    return undefined;
  }
  const candidates = ["/usr/bin/chromium", "/usr/bin/google-chrome"];
  return candidates.find((candidate) => existsSync(candidate));
}

const executablePath = resolveChromiumExecutablePath();
const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: process.env["CI"] === "true",
  retries: process.env["CI"] === "true" ? 1 : 0,
  reporter: process.env["CI"] === "true" ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...(executablePath !== undefined ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "pc-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "sp-360",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 780 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "sp-320",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 640 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command:
      process.env["CI"] === "true"
        ? `bunx vite preview --host 127.0.0.1 --port ${port} --strictPort`
        : `bunx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: process.env["CI"] !== "true",
    timeout: 30_000,
  },
});
