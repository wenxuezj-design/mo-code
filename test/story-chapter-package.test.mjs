import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  discoverChapterPages,
  packageChapter,
} from "../docs/story/tools/lettering/lib/chapter-package.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function pngFixture(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let row = 0; row < height; row += 1) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function layout(page) {
  return {
    version: 1,
    chapter: "01-agent-loop",
    page,
    source: { file: `page-${page}-base.webp`, width: 864, height: 1821 },
    items: [],
  };
}

async function fixture(t, pages = ["10", "02", "01"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layoutRoot = path.join(root, "docs/story/chapters/01-agent-loop/pages");
  const exportRoot = path.join(root, ".story-assets/exports/01-agent-loop");
  await mkdir(layoutRoot, { recursive: true });
  for (const page of pages) {
    await writeFile(
      path.join(layoutRoot, `page-${page}-lettering.json`),
      `${JSON.stringify(layout(page), null, 2)}\n`,
    );
  }
  return { root, layoutRoot, exportRoot };
}

async function writeRenderedPages(app, dimensions = { "01": [1, 2], "02": [2, 3], "10": [3, 4] }) {
  const pagesRoot = path.join(app.exportRoot, "pages");
  await mkdir(pagesRoot, { recursive: true });
  for (const [page, [width, height]] of Object.entries(dimensions)) {
    await writeFile(path.join(pagesRoot, `page-${page}-final.png`), pngFixture(width, height));
    await writeFile(path.join(pagesRoot, `page-${page}-final.webp`), Buffer.from(`webp-${page}`));
  }
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), (error) => error.code === "ENOENT");
}

test("discovers lettering pages in numeric page order", async (t) => {
  const app = await fixture(t);

  const pages = await discoverChapterPages({
    projectRoot: app.root,
    chapter: "01-agent-loop",
  });

  assert.deepEqual(pages.map(({ page }) => page), ["01", "02", "10"]);
});

test("lists every missing PNG and WebP before packaging", async (t) => {
  const app = await fixture(t, ["01", "02"]);
  const pagesRoot = path.join(app.exportRoot, "pages");
  await mkdir(pagesRoot, { recursive: true });
  await writeFile(path.join(pagesRoot, "page-01-final.png"), pngFixture(1, 1));
  await writeFile(path.join(pagesRoot, "page-02-final.webp"), Buffer.from("webp-02"));

  await assert.rejects(
    packageChapter({
      projectRoot: app.root,
      chapter: "01-agent-loop",
      formats: ["web", "pdf", "cbz"],
    }),
    (error) => {
      assert.match(error.message, /page-01-final\.webp/);
      assert.match(error.message, /page-02-final\.png/);
      return true;
    },
  );
});

test("packages a self-contained Web chapter under the fixed web path", async (t) => {
  const app = await fixture(t);
  await writeRenderedPages(app);

  const result = await packageChapter({
    projectRoot: app.root,
    chapter: "01-agent-loop",
    formats: ["web"],
  });

  assert.equal(result.web, path.join(app.exportRoot, "web/index.html"));
  const indexHtml = await readFile(result.web, "utf8");
  const pageHtml = await readFile(path.join(app.exportRoot, "web/page-02.html"), "utf8");
  assert.deepEqual(
    [...indexHtml.matchAll(/src="([^"]+)"/g)].map((match) => match[1]),
    [
      "pages/page-01-final.webp",
      "pages/page-02-final.webp",
      "pages/page-10-final.webp",
    ],
  );
  assert.match(pageHtml, /src="pages\/page-02-final\.webp"/);
  assert.match(pageHtml, /href="page-01\.html"/);
  assert.match(pageHtml, /href="page-10\.html"/);
  assert.deepEqual(await readdir(path.join(app.exportRoot, "web/pages")), [
    "page-01-final.webp",
    "page-02-final.webp",
    "page-10-final.webp",
  ]);
  assert.deepEqual(
    await readFile(path.join(app.exportRoot, "web/pages/page-02-final.webp")),
    Buffer.from("webp-02"),
  );
  await assertMissing(path.join(app.exportRoot, "index.html"));
  await assertMissing(path.join(app.exportRoot, "page-02.html"));
});

test("packages one intrinsic-size PDF page per layout at the fixed chapter path", async (t) => {
  const app = await fixture(t);
  await writeRenderedPages(app);

  const result = await packageChapter({
    projectRoot: app.root,
    chapter: "01-agent-loop",
    formats: ["pdf"],
  });

  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.load(await readFile(result.pdf));
  assert.equal(result.pdf, path.join(app.exportRoot, "chapter-01-agent-loop.pdf"));
  assert.equal(pdf.getPageCount(), 3);
  assert.deepEqual(
    pdf.getPages().map((pdfPage) => pdfPage.getSize()),
    [
      { width: 1, height: 2 },
      { width: 2, height: 3 },
      { width: 3, height: 4 },
    ],
  );
  await assertMissing(path.join(app.exportRoot, "01-agent-loop.pdf"));
});

test("packages numerically ordered WebP entries at the fixed CBZ path", async (t) => {
  const app = await fixture(t);
  await writeRenderedPages(app);

  const result = await packageChapter({
    projectRoot: app.root,
    chapter: "01-agent-loop",
    formats: ["cbz"],
  });

  const { unzipSync } = await import("fflate");
  const archive = unzipSync(await readFile(result.cbz));
  assert.equal(result.cbz, path.join(app.exportRoot, "chapter-01-agent-loop.cbz"));
  assert.deepEqual(Object.keys(archive), [
    "page-01-final.webp",
    "page-02-final.webp",
    "page-10-final.webp",
  ]);
  assert.deepEqual(Buffer.from(archive["page-02-final.webp"]), Buffer.from("webp-02"));
  await assertMissing(path.join(app.exportRoot, "01-agent-loop.cbz"));
});
