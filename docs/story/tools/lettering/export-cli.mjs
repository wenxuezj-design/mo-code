#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLetteringServer } from "./server.mjs";
import { packageChapter, discoverChapterPages } from "./lib/chapter-package.mjs";
import { exportPageInChrome } from "./lib/chrome-export.mjs";
import { assertSafeSegment } from "./lib/paths.mjs";

const CLI_FORMATS = new Set(["pages", "web", "pdf", "cbz"]);
const OPTIONS = new Set(["chapter", "page", "formats"]);

export function parseExportArgs(argv) {
  const tokens = argv[0] === "--" ? argv.slice(1) : [...argv];
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      throw new Error(`invalid option: ${String(flag)}`);
    }
    const name = flag.slice(2);
    if (!OPTIONS.has(name)) throw new Error(`unsupported option: ${flag}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${flag}`);
    options[name] = value;
  }

  if (!options.chapter) throw new Error("--chapter is required");
  const chapter = assertSafeSegment(options.chapter, "chapter");
  if (options.page !== undefined && !/^\d{2}$/.test(options.page)) {
    throw new Error("--page must be exactly two digits");
  }
  const formats = options.formats === undefined ? ["pages"] : options.formats.split(",");
  if (formats.length === 0 || formats.some((format) => !CLI_FORMATS.has(format))) {
    throw new Error(`unsupported format: ${options.formats}`);
  }
  if (new Set(formats).size !== formats.length) throw new Error("formats must not contain duplicates");
  if (options.page !== undefined && formats.some((format) => format !== "pages")) {
    throw new Error("--page can only be combined with --formats pages");
  }
  return { chapter, page: options.page, formats };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  createServer = createLetteringServer,
  discoverPages = discoverChapterPages,
  exportPage = exportPageInChrome,
  packageChapterImpl = packageChapter,
} = {}) {
  let app;
  try {
    const options = parseExportArgs(argv);
    const projectRoot = path.resolve(cwd);
    const discovered = await discoverPages({ projectRoot, chapter: options.chapter });
    const selectedPages = options.page === undefined
      ? discovered
      : discovered.filter(({ page }) => page === options.page);
    if (selectedPages.length === 0) {
      throw new Error(`No lettering layout found for page ${options.page}`);
    }

    app = await createServer({ projectRoot, host: "127.0.0.1", port: 0 });
    for (const entry of selectedPages) {
      await exportPage({
        editorUrl: app.url,
        chapter: options.chapter,
        page: entry.page,
        formats: ["png", "webp"],
        env,
      });
      stdout.write(`Rendered page ${entry.page} as PNG and WebP\n`);
    }

    const packageFormats = options.formats.filter((format) => format !== "pages");
    if (packageFormats.length) {
      await packageChapterImpl({
        projectRoot,
        chapter: options.chapter,
        formats: packageFormats,
      });
      stdout.write(`Packaged chapter as ${packageFormats.join(", ")}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (app) await closeServer(app.server);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.exitCode = await main();
}
