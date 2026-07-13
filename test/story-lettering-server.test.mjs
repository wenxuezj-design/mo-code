import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("GET page returns layout and base URL", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.url}/api/pages/01-agent-loop/01`);

  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.layout.items[0].id, "D01");
  assert.equal(value.baseUrl, "/api/pages/01-agent-loop/01/base");
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
