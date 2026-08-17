import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

import { atomicWrite } from "./http.mjs";
import { assertSafeSegment, resolvePagePaths } from "./paths.mjs";

const PAGE_LAYOUT_PATTERN = /^page-(\d{2})-lettering\.json$/;
const PACKAGE_FORMATS = new Set(["web", "pdf", "cbz"]);

function projectPath(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("projectRoot must be a non-empty string");
  }
  return path.resolve(projectRoot);
}

function normalizedFormats(formats) {
  if (!Array.isArray(formats) || formats.length === 0) {
    throw new Error("formats must contain web, pdf, or cbz");
  }
  const unique = [...new Set(formats)];
  const invalid = unique.filter((format) => !PACKAGE_FORMATS.has(format));
  if (invalid.length) throw new Error(`Unsupported chapter format: ${invalid.join(", ")}`);
  return unique;
}

export async function discoverChapterPages({ projectRoot, chapter }) {
  const root = projectPath(projectRoot);
  const safeChapter = assertSafeSegment(chapter, "chapter");
  const pagesRoot = path.join(root, "docs", "story", "chapters", safeChapter, "pages");
  const entries = await readdir(pagesRoot, { withFileTypes: true });
  const pages = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ entry, match: PAGE_LAYOUT_PATTERN.exec(entry.name) }))
    .filter(({ match }) => match)
    .map(({ entry, match }) => ({
      page: match[1],
      layoutPath: path.join(pagesRoot, entry.name),
    }))
    .sort((left, right) => Number(left.page) - Number(right.page));
  if (pages.length === 0) throw new Error(`No lettering layouts found for chapter ${safeChapter}`);

  return Promise.all(pages.map(async (entry) => {
    const layout = JSON.parse(await readFile(entry.layoutPath, "utf8"));
    if (layout.chapter !== safeChapter || layout.page !== entry.page) {
      throw new Error(`Layout route mismatch: ${path.basename(entry.layoutPath)}`);
    }
    return { ...entry, layout };
  }));
}

async function chapterInputs({ projectRoot, chapter, pages }) {
  const missing = [];
  const inputs = pages.map((entry) => {
    const paths = resolvePagePaths({ projectRoot, chapter, page: entry.page });
    return { ...entry, png: paths.finalPng, webp: paths.finalWebp };
  });
  for (const input of inputs) {
    for (const filePath of [input.png, input.webp]) {
      try {
        await access(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missing.push(filePath);
      }
    }
  }
  if (missing.length) {
    throw new Error(`Missing rendered chapter pages:\n${missing.map((filePath) => `- ${filePath}`).join("\n")}`);
  }
  return inputs;
}

function htmlDocument({ title, body, extraHead = "" }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>html{background:#111;color:#eee;font-family:system-ui,sans-serif}body{margin:0}main{max-width:864px;margin:auto}img{display:block;width:100%;height:auto}nav{display:flex;justify-content:space-between;padding:16px}a{color:#fff}</style>
  ${extraHead}
</head>
<body>${body}</body>
</html>
`;
}

async function writeWeb({ exportRoot, chapter, inputs }) {
  const webRoot = path.join(exportRoot, "web");
  const indexImages = inputs.map(({ page }) => (
    `<img src="pages/page-${page}-final.webp" alt="第 ${Number(page)} 页" loading="lazy">`
  )).join("\n");
  await atomicWrite(
    path.join(webRoot, "index.html"),
    htmlDocument({ title: chapter, body: `<main>\n${indexImages}\n</main>` }),
  );

  await Promise.all(inputs.map(async (input, index) => {
    const { page } = input;
    const previous = inputs[index - 1];
    const next = inputs[index + 1];
    const nav = `<nav>${previous ? `<a href="page-${previous.page}.html">上一页</a>` : "<span></span>"}<a href="index.html">整章</a>${next ? `<a href="page-${next.page}.html">下一页</a>` : "<span></span>"}</nav>`;
    const image = `<main><img src="pages/page-${page}-final.webp" alt="第 ${Number(page)} 页"></main>`;
    await Promise.all([
      atomicWrite(
        path.join(webRoot, `page-${page}.html`),
        htmlDocument({ title: `${chapter} · ${page}`, body: `${nav}${image}${nav}` }),
      ),
      atomicWrite(
        path.join(webRoot, "pages", `page-${page}-final.webp`),
        await readFile(input.webp),
      ),
    ]);
  }));
  return path.join(webRoot, "index.html");
}

async function writePdf({ exportRoot, chapter, inputs }) {
  const document = await PDFDocument.create();
  for (const input of inputs) {
    const image = await document.embedPng(await readFile(input.png));
    const pdfPage = document.addPage([image.width, image.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const output = path.join(exportRoot, `chapter-${chapter}.pdf`);
  await atomicWrite(output, await document.save());
  return output;
}

async function writeCbz({ exportRoot, chapter, inputs }) {
  const entries = {};
  for (const input of inputs) {
    entries[`page-${input.page}-final.webp`] = await readFile(input.webp);
  }
  const output = path.join(exportRoot, `chapter-${chapter}.cbz`);
  await atomicWrite(output, zipSync(entries, { level: 0 }));
  return output;
}

export async function packageChapter({ projectRoot, chapter, formats = ["web", "pdf", "cbz"] }) {
  const root = projectPath(projectRoot);
  const safeChapter = assertSafeSegment(chapter, "chapter");
  const selectedFormats = normalizedFormats(formats);
  const pages = await discoverChapterPages({ projectRoot: root, chapter: safeChapter });
  const inputs = await chapterInputs({ projectRoot: root, chapter: safeChapter, pages });
  const exportRoot = path.join(root, ".story-assets", "exports", safeChapter);
  const result = { chapter: safeChapter, pages: inputs.map(({ page }) => page) };

  for (const format of selectedFormats) {
    if (format === "web") result.web = await writeWeb({ exportRoot, chapter: safeChapter, inputs });
    if (format === "pdf") result.pdf = await writePdf({ exportRoot, chapter: safeChapter, inputs });
    if (format === "cbz") result.cbz = await writeCbz({ exportRoot, chapter: safeChapter, inputs });
  }
  return result;
}
