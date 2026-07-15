import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLetteringServer } from "../docs/story/tools/lettering/server.mjs";

function pngFixture(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function webpFixture(width, height) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

const DEFAULT_BASE_BYTES = webpFixture(864, 1821);

function assetMetadata({ bytes, remotePath, cacheFile, width, height }) {
  return {
    remotePath,
    cacheFile,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    width,
    height,
  };
}

function layout() {
  return {
    version: 1,
    chapter: "01-agent-loop",
    page: "01",
    source: { file: "page-01-base.webp", width: 864, height: 1821 },
    items: [{
      id: "D01", type: "speech", speaker: "若叶墨", text: "测试",
      direction: "horizontal", x: 10, y: 10, width: 120, height: 100,
      padding: 10, fontFamily: "PingFang SC", fontSize: 28,
      minFontSize: 18, fontWeight: 500, lineHeight: 1.35, align: "center",
    }],
  };
}

const PORTRAIT_ID = "wakaba-mortis-confused-v1";
const PORTRAIT_BYTES = Buffer.from("RIFF-portrait-WEBP");

function generatedLayout() {
  return {
    version: 1,
    chapter: "01-agent-loop",
    page: "12",
    source: { kind: "generated", width: 400, height: 600, background: "#f7f5ef" },
    items: [
      {
        id: "P01", type: "portrait", portraitId: PORTRAIT_ID,
        x: 20, y: 20, width: 120, height: 120, shape: "circle", grayscale: true,
      },
      {
        id: "T01", type: "technical", speaker: null, text: "同一颗心脏",
        direction: "horizontal", x: 20, y: 170, width: 300, height: 80,
        padding: 10, fontFamily: "PingFang SC", fontSize: 28,
        minFontSize: 18, fontWeight: 700, lineHeight: 1.25, align: "left",
        appearance: "title",
      },
    ],
  };
}

function generatedTextLayout(page) {
  const value = layout();
  value.page = page;
  value.source = { kind: "generated", width: 864, height: 1821, background: "#f7f5ef" };
  return value;
}

function portraitCatalog() {
  return {
    [PORTRAIT_ID]: {
      label: "若叶墨 · 困惑",
      character: "若叶墨",
      expression: "困惑",
      file: "wakaba-mortis/character-sheet-v1.webp",
      crop: { x: 835, y: 80, width: 380, height: 380 },
    },
  };
}

function manifest() {
  return {
    version: 1,
    chapter: "01-agent-loop",
    pages: {
      "01": {
        base: {
          ...assetMetadata({
            bytes: DEFAULT_BASE_BYTES,
            remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.webp",
            cacheFile: "page-01-base.webp",
            width: 864,
            height: 1821,
          }),
        },
      },
    },
  };
}

async function fixture(
  t,
  {
    includeBase = true,
    source = layout().source,
    asset = manifest().pages["01"].base,
    baseBytes = DEFAULT_BASE_BYTES,
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lettering-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chapterDir = path.join(root, "docs/story/chapters/01-agent-loop");
  const pageDir = path.join(root, "docs/story/chapters/01-agent-loop/pages");
  const cacheDir = path.join(root, ".story-assets/cache/01-agent-loop");
  const exportsDir = path.join(root, ".story-assets/exports/01-agent-loop/pages");
  await mkdir(pageDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const pageLayout = layout();
  pageLayout.source = source;
  const chapterManifest = manifest();
  chapterManifest.pages["01"].base = asset;
  await writeFile(
    path.join(chapterDir, "assets.json"),
    `${JSON.stringify(chapterManifest, null, 2)}\n`,
  );
  if (includeBase) {
    await writeFile(path.join(cacheDir, asset.cacheFile), baseBytes);
  }
  await writeFile(path.join(pageDir, "page-01-lettering.json"), `${JSON.stringify(pageLayout, null, 2)}\n`);
  const app = await createLetteringServer({ projectRoot: root, host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return { root, pageDir, cacheDir, exportsDir, ...app };
}

async function generatedFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lettering-generated-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pageDir = path.join(root, "docs/story/chapters/01-agent-loop/pages");
  const characterDir = path.join(root, "docs/story/assets/characters");
  const sheetDir = path.join(characterDir, "wakaba-mortis");
  const exportsDir = path.join(root, ".story-assets/exports/01-agent-loop/pages");
  await mkdir(pageDir, { recursive: true });
  await mkdir(sheetDir, { recursive: true });
  await writeFile(
    path.join(pageDir, "page-12-lettering.json"),
    `${JSON.stringify(generatedLayout(), null, 2)}\n`,
  );
  await writeFile(
    path.join(characterDir, "portraits.json"),
    `${JSON.stringify(portraitCatalog(), null, 2)}\n`,
  );
  await writeFile(path.join(sheetDir, "character-sheet-v1.webp"), PORTRAIT_BYTES);
  const app = await createLetteringServer({ projectRoot: root, host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return { root, pageDir, exportsDir, ...app };
}

test("GET page returns layout and base URL", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/01`);

  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.layout.items[0].id, "D01");
  assert.equal(value.baseUrl, "/api/pages/01-agent-loop/01/base");
  assert.deepEqual(value.portraits, {});
});

test("GET save queue module serves the browser serialization helper", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.url}/lib/save-queue.mjs`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/javascript/);
  assert.match(await response.text(), /export function createSaveQueue/);
});

test("GET page returns neighboring pages from the actual lettering files", async (t) => {
  const app = await fixture(t);
  for (const page of ["03", "07"]) {
    await writeFile(
      path.join(app.pageDir, `page-${page}-lettering.json`),
      `${JSON.stringify(generatedTextLayout(page), null, 2)}\n`,
    );
  }

  const first = await fetch(`${app.url}/api/pages/01-agent-loop/01`);
  const middle = await fetch(`${app.url}/api/pages/01-agent-loop/03`);
  const last = await fetch(`${app.url}/api/pages/01-agent-loop/07`);

  assert.equal(first.status, 200);
  assert.equal(middle.status, 200);
  assert.equal(last.status, 200);
  assert.deepEqual((await first.json()).navigation, { previous: null, next: "03" });
  assert.deepEqual((await middle.json()).navigation, { previous: "01", next: "07" });
  assert.deepEqual((await last.json()).navigation, { previous: "03", next: null });
});

test("GET generated page needs no asset manifest and returns safe referenced portrait metadata", async (t) => {
  const app = await generatedFixture(t);
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/12`);

  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.layout.source.kind, "generated");
  assert.equal(value.baseUrl, null);
  assert.deepEqual(value.portraits, {
    [PORTRAIT_ID]: {
      label: "若叶墨 · 困惑",
      character: "若叶墨",
      expression: "困惑",
      crop: { x: 835, y: 80, width: 380, height: 380 },
      imageUrl: `/api/portraits/${PORTRAIT_ID}/image`,
    },
  });
  assert.equal(Object.hasOwn(value.portraits[PORTRAIT_ID], "file"), false);
});

test("GET portrait image serves only the catalog-owned character sheet", async (t) => {
  const app = await generatedFixture(t);
  const response = await fetch(`${app.url}/api/portraits/${PORTRAIT_ID}/image`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PORTRAIT_BYTES);
});

test("portrait image route rejects unknown IDs and traversal", async (t) => {
  const app = await generatedFixture(t);
  const unknown = await fetch(`${app.url}/api/portraits/wakaba-mortis-unknown-v1/image`);
  const traversal = await fetch(`${app.url}/api/portraits/%2E%2E%2Fsecret/image`);

  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "PORTRAIT_NOT_FOUND");
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).code, "INVALID_PATH");
});

test("portrait image route refuses a catalog sheet symlink that escapes the character root", async (t) => {
  const app = await generatedFixture(t);
  const sheetPath = path.join(
    app.root,
    "docs/story/assets/characters/wakaba-mortis/character-sheet-v1.webp",
  );
  const outsideBytes = Buffer.from("private-outside-portrait");
  const outsidePath = path.join(app.root, "private.webp");
  await writeFile(outsidePath, outsideBytes);
  await rm(sheetPath);
  try {
    await symlink(outsidePath, sheetPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("file symlinks are unavailable on this platform");
      return;
    }
    throw error;
  }

  const response = await fetch(`${app.url}/api/portraits/${PORTRAIT_ID}/image`);
  const body = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 403);
  assert.equal(JSON.parse(body.toString("utf8")).code, "PORTRAIT_IMAGE_UNSAFE");
  assert.notDeepEqual(body, outsideBytes);
});

test("GET base serves the manifest-selected PNG cache file with its correct MIME", async (t) => {
  const baseBytes = pngFixture(864, 1821);
  const asset = assetMetadata({
    bytes: baseBytes,
    remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.png",
    cacheFile: "page-01-render.png",
    width: 864,
    height: 1821,
  });
  const source = { file: asset.cacheFile, width: asset.width, height: asset.height };
  const app = await fixture(t, { asset, source, baseBytes });

  const pageResponse = await fetch(`${app.url}/api/pages/01-agent-loop/01`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  const baseResponse = await fetch(`${app.url}${page.baseUrl}`);

  assert.equal(baseResponse.status, 200);
  assert.equal(baseResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await baseResponse.arrayBuffer()), baseBytes);
});

test("page routes reject manifest base formats outside WebP and PNG", async (t) => {
  const asset = {
    ...manifest().pages["01"].base,
    remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.jpg",
    cacheFile: "page-01-base.jpg",
  };
  const source = { file: asset.cacheFile, width: asset.width, height: asset.height };
  const app = await fixture(t, { asset, source });

  for (const suffix of ["", "/base"]) {
    const response = await fetch(`${app.url}/api/pages/01-agent-loop/01${suffix}`);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, "UNSUPPORTED_BASE_FORMAT");
  }
});

test("GET page rejects layout source fields that disagree with the asset manifest", async (t) => {
  const mismatches = [
    { file: "other.webp", width: 864, height: 1821 },
    { file: "page-01-base.webp", width: 865, height: 1821 },
    { file: "page-01-base.webp", width: 864, height: 1822 },
  ];

  for (const source of mismatches) {
    await t.test(JSON.stringify(source), async (t) => {
      const app = await fixture(t, { source });
      const response = await fetch(`${app.url}/api/pages/01-agent-loop/01`);

      assert.equal(response.status, 409);
      const value = await response.json();
      assert.equal(value.code, "LAYOUT_ASSET_MISMATCH");
    });
  }
});

test("GET page explains how to pull a missing cached base image", async (t) => {
  const app = await fixture(t, { includeBase: false });
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/01`);

  assert.equal(response.status, 404);
  const value = await response.json();
  assert.match(
    value.message,
    /pnpm story:assets:pull -- --chapter 01-agent-loop --page 01/,
  );
});

test("page and base routes reject a stale cached image and show the pull command", async (t) => {
  const staleBytes = Buffer.from(DEFAULT_BASE_BYTES);
  staleBytes[20] = 1;
  const expectedAsset = manifest().pages["01"].base;
  const app = await fixture(t, { asset: expectedAsset, baseBytes: staleBytes });

  for (const suffix of ["", "/base"]) {
    const response = await fetch(`${app.url}/api/pages/01-agent-loop/01${suffix}`);
    assert.equal(response.status, 409);
    const value = await response.json();
    assert.equal(value.code, "BASE_ASSET_STALE");
    assert.match(value.message, /pnpm story:assets:pull -- --chapter 01-agent-loop --page 01/);
  }
});

test("PUT layout atomically saves validated JSON", async (t) => {
  const app = await fixture(t);
  const updated = layout();
  updated.items[0].x = 88;
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/01/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated),
  });

  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(path.join(app.pageDir, "page-01-lettering.json"), "utf8"));
  assert.equal(saved.items[0].x, 88);
});

test("PUT generated layout skips the base manifest and validates referenced portrait IDs", async (t) => {
  const app = await generatedFixture(t);
  const updated = generatedLayout();
  updated.items[0].x = 42;
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/12/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated),
  });

  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(path.join(app.pageDir, "page-12-lettering.json"), "utf8"));
  assert.equal(saved.items[0].x, 42);
});

test("PUT generated layout rejects an unknown portrait without replacing the file", async (t) => {
  const app = await generatedFixture(t);
  const layoutPath = path.join(app.pageDir, "page-12-lettering.json");
  const before = await readFile(layoutPath, "utf8");
  const updated = generatedLayout();
  updated.items[0].portraitId = "wakaba-mortis-unknown-v1";
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/12/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "UNKNOWN_PORTRAIT_ID");
  assert.equal(await readFile(layoutPath, "utf8"), before);
});

test("PUT layout rejects asset source mismatches without replacing the file", async (t) => {
  const mismatches = [
    { file: "other.webp", width: 864, height: 1821 },
    { file: "page-01-base.webp", width: 865, height: 1821 },
    { file: "page-01-base.webp", width: 864, height: 1822 },
  ];

  for (const source of mismatches) {
    await t.test(JSON.stringify(source), async (t) => {
      const app = await fixture(t);
      const before = await readFile(path.join(app.pageDir, "page-01-lettering.json"), "utf8");
      const updated = layout();
      updated.source = source;

      const response = await fetch(`${app.url}/api/pages/01-agent-loop/01/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updated),
      });

      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "LAYOUT_ASSET_MISMATCH");
      assert.equal(
        await readFile(path.join(app.pageDir, "page-01-lettering.json"), "utf8"),
        before,
      );
    });
  }
});

test("PUT layout rejects invalid JSON without replacing the file", async (t) => {
  const app = await fixture(t);
  const before = await readFile(path.join(app.pageDir, "page-01-lettering.json"), "utf8");
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/01/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{broken",
  });

  assert.equal(response.status, 400);
  assert.equal(await readFile(path.join(app.pageDir, "page-01-lettering.json"), "utf8"), before);
});

test("POST export writes WebP and PNG only to the exports pages directory", async (t) => {
  const app = await fixture(t);
  const webp = Buffer.from("RIFF-test-WEBP");
  const png = Buffer.from("PNG-test");

  const webpResponse = await fetch(`${app.url}/api/pages/01-agent-loop/01/export/webp`, { method: "POST", body: webp });
  const pngResponse = await fetch(`${app.url}/api/pages/01-agent-loop/01/export/png`, { method: "POST", body: png });

  assert.equal(webpResponse.status, 200);
  assert.equal(pngResponse.status, 200);
  assert.deepEqual(await readFile(path.join(app.exportsDir, "page-01-final.webp")), webp);
  assert.deepEqual(await readFile(path.join(app.exportsDir, "page-01-final.png")), png);
  await assert.rejects(
    readFile(path.join(app.pageDir, "page-01-final.webp")),
    (error) => error.code === "ENOENT",
  );
});

test("API rejects invalid path segments and unsupported exports", async (t) => {
  const app = await fixture(t);
  const traversal = await fetch(`${app.url}/api/pages/%2E%2E%2Fsecret/01`);
  const unsupported = await fetch(`${app.url}/api/pages/01-agent-loop/01/export/jpeg`, { method: "POST", body: "x" });

  assert.equal(traversal.status, 400);
  assert.equal(unsupported.status, 404);
});
