import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.SITE_BASE_URL;

export default defineConfig({
  testDir: "./test/site-browser",
  outputDir: "./test-results/site-browser",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.025,
      scale: "css",
    },
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  use: {
    baseURL: externalBaseUrl || "http://127.0.0.1:4173",
    colorScheme: "dark",
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    timezoneId: "UTC",
    launchOptions: {
      args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader"],
    },
  },
  webServer: externalBaseUrl ? undefined : {
    command: "node scripts/serve-site.mjs",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { browserName: "chromium", isMobile: true, viewport: { width: 390, height: 844 } },
    },
  ],
});
