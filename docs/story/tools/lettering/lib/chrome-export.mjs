import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

function chromeCandidates({ env, platform, homedir }) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(homedir, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (platform === "win32") {
    return [
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
      env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    ].filter(Boolean);
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export async function findChromeExecutable({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  accessFile = access,
} = {}) {
  if (env.STORY_CHROME_PATH !== undefined) {
    const configured = env.STORY_CHROME_PATH;
    try {
      if (typeof configured !== "string" || configured.length === 0) throw new Error("empty path");
      await accessFile(configured, constants.X_OK);
      return configured;
    } catch (cause) {
      const error = new Error(
        `STORY_CHROME_PATH does not point to an executable: ${String(configured)}`,
        { cause },
      );
      error.code = "STORY_CHROME_PATH_INVALID";
      throw error;
    }
  }

  const candidates = chromeCandidates({ env, platform, homedir });
  for (const candidate of candidates) {
    try {
      await accessFile(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the platform's known Chrome locations.
    }
  }
  const error = new Error(
    "Chrome was not found. Install Google Chrome or set STORY_CHROME_PATH to its executable.",
  );
  error.code = "STORY_CHROME_MISSING";
  throw error;
}

function evaluateTimeout(timeoutMs, chapter, page) {
  const error = new Error(
    `Browser page export timed out after ${timeoutMs}ms for ${chapter} page ${page}`,
  );
  error.code = "STORY_EXPORT_TIMEOUT";
  return error;
}

async function withTimeout(promise, timeoutMs, timeoutError) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function exportPageInChrome({
  editorUrl,
  chapter,
  page,
  formats = ["png", "webp"],
  chromePath,
  env = process.env,
  evaluateTimeoutMs = 30_000,
  launchBrowser = (options) => chromium.launch(options),
} = {}) {
  const executablePath = chromePath ?? await findChromeExecutable({ env });
  const browser = await launchBrowser({
    executablePath,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const browserPage = await browser.newPage();
    const url = new URL(editorUrl);
    url.searchParams.set("chapter", chapter);
    url.searchParams.set("page", page);
    await browserPage.goto(url.href, { waitUntil: "networkidle" });
    await browserPage.waitForFunction(() => typeof window.__storyExportPage === "function");
    return await withTimeout(
      Promise.resolve().then(() => browserPage.evaluate(
        (selectedFormats) => window.__storyExportPage({ formats: selectedFormats }),
        formats,
      )),
      evaluateTimeoutMs,
      evaluateTimeout(evaluateTimeoutMs, chapter, page),
    );
  } finally {
    await browser.close();
  }
}
