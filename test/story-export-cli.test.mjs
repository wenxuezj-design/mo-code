import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  exportPageInChrome,
  findChromeExecutable,
} from "../docs/story/tools/lettering/lib/chrome-export.mjs";

function fakeBrowser(evaluate) {
  let closeCount = 0;
  return {
    browser: {
      async newPage() {
        return {
          async goto() {},
          async waitForFunction() {},
          evaluate,
        };
      },
      async close() { closeCount += 1; },
    },
    closeCount: () => closeCount,
  };
}

test("browser hook waits for readiness and exports PNG and WebP through the page renderer", async () => {
  const app = await readFile(
    new URL("../docs/story/tools/lettering/app.js", import.meta.url),
    "utf8",
  );

  assert.match(app, /window\.__storyExportPage/);
  assert.match(app, /document\.fonts\.ready/);
  assert.match(app, /await saveLayout\(\)/);
  assert.match(app, /checkAllOverflow\(\{ announce: false \}\)/);
  assert.match(app, /renderPageBlob\(\{ image: refs\.baseImage, layout, format \}\)/);
});

test("CLI parser accepts pnpm's delimiter and only two-digit pages and supported formats", async () => {
  const { parseExportArgs } = await import(
    "../docs/story/tools/lettering/export-cli.mjs"
  );

  assert.deepEqual(
    parseExportArgs(["--", "--chapter", "01-agent-loop", "--page", "01"]),
    { chapter: "01-agent-loop", page: "01", formats: ["pages"] },
  );
  assert.deepEqual(
    parseExportArgs(["--chapter", "01-agent-loop", "--formats", "web,pdf,cbz"]),
    { chapter: "01-agent-loop", page: undefined, formats: ["web", "pdf", "cbz"] },
  );
  assert.throws(
    () => parseExportArgs(["--chapter", "01-agent-loop", "--page", "1"]),
    /two digits/,
  );
  assert.throws(
    () => parseExportArgs(["--chapter", "01-agent-loop", "--formats", "web,jpeg"]),
    /unsupported format/i,
  );
});

test("chapter formats rerender every page as PNG and WebP before packaging", async () => {
  const { main } = await import("../docs/story/tools/lettering/export-cli.mjs");
  const events = [];
  let closed = false;
  const stdout = { write() {} };
  const stderr = { write(message) { assert.fail(message); } };

  const exitCode = await main({
    argv: ["--", "--chapter", "01-agent-loop", "--formats", "web,pdf,cbz"],
    cwd: "/project",
    stdout,
    stderr,
    createServer: async () => ({
      url: "http://127.0.0.1:43123",
      server: { close(callback) { closed = true; callback(); } },
    }),
    discoverPages: async () => [{ page: "01" }, { page: "02" }],
    exportPage: async ({ page, formats }) => {
      events.push(`export:${page}:${formats.join(",")}`);
    },
    packageChapterImpl: async ({ formats }) => {
      events.push(`package:${formats.join(",")}`);
      return {};
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(closed, true);
  assert.deepEqual(events, [
    "export:01:png,webp",
    "export:02:png,webp",
    "package:web,pdf,cbz",
  ]);
});

test("configured STORY_CHROME_PATH is authoritative when it is not executable", async () => {
  const configuredPath = "/configured/chrome";
  const attempted = [];

  await assert.rejects(
    findChromeExecutable({
      env: { STORY_CHROME_PATH: configuredPath },
      platform: "darwin",
      homedir: "/Users/tester",
      accessFile: async (candidate) => {
        attempted.push(candidate);
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, "STORY_CHROME_PATH_INVALID");
      assert.match(error.message, /STORY_CHROME_PATH/);
      assert.match(error.message, /\/configured\/chrome/);
      return true;
    },
  );
  assert.deepEqual(attempted, [configuredPath]);
});

test("page export times out a stalled browser hook and always closes Chrome", async () => {
  const fake = fakeBrowser(() => new Promise(() => {}));

  await assert.rejects(
    exportPageInChrome({
      editorUrl: "http://127.0.0.1:43123",
      chapter: "01-agent-loop",
      page: "01",
      chromePath: "/fake/chrome",
      evaluateTimeoutMs: 5,
      launchBrowser: async () => fake.browser,
    }),
    (error) => {
      assert.equal(error.code, "STORY_EXPORT_TIMEOUT");
      assert.match(error.message, /5ms/);
      return true;
    },
  );
  assert.equal(fake.closeCount(), 1);
});

test("page export closes Chrome when the browser hook throws", async () => {
  const fake = fakeBrowser(async () => { throw new Error("hook exploded"); });

  await assert.rejects(
    exportPageInChrome({
      editorUrl: "http://127.0.0.1:43123",
      chapter: "01-agent-loop",
      page: "01",
      chromePath: "/fake/chrome",
      evaluateTimeoutMs: 5,
      launchBrowser: async () => fake.browser,
    }),
    /hook exploded/,
  );
  assert.equal(fake.closeCount(), 1);
});
