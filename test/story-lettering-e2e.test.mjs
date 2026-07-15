import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLetteringServer } from "../docs/story/tools/lettering/server.mjs";

function webpFixture(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

test("HTTP first-page workflow serves the cached base and persists edits and exports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lettering-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chapterDir = path.join(root, "docs/story/chapters/01-agent-loop");
  const pageDir = path.join(root, "docs/story/chapters/01-agent-loop/pages");
  const cacheDir = path.join(root, ".story-assets/cache/01-agent-loop");
  const exportsDir = path.join(root, ".story-assets/exports/01-agent-loop/pages");
  await mkdir(pageDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const initial = {
    version: 1,
    chapter: "01-agent-loop",
    page: "01",
    source: { file: "page-01-base.webp", width: 864, height: 1821 },
    items: [{
      id: "N02", type: "narration", speaker: null, text: "她会写一些前端代码。",
      direction: "vertical", x: 420, y: 1123, width: 111, height: 230,
      padding: 12, fontFamily: "PingFang SC", fontSize: 28,
      minFontSize: 18, fontWeight: 600, lineHeight: 1.35, align: "center",
    }],
  };
  const baseBytes = webpFixture(initial.source.width, initial.source.height);
  const assets = {
    version: 1,
    chapter: "01-agent-loop",
    pages: {
      "01": {
        base: {
          remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.webp",
          cacheFile: "page-01-base.webp",
          sha256: createHash("sha256").update(baseBytes).digest("hex"),
          bytes: baseBytes.length,
          width: 864,
          height: 1821,
        },
      },
    },
  };
  await writeFile(path.join(chapterDir, "assets.json"), JSON.stringify(assets));
  await writeFile(path.join(cacheDir, "page-01-base.webp"), baseBytes);
  await writeFile(path.join(pageDir, "page-01-lettering.json"), JSON.stringify(initial));

  const app = await createLetteringServer({ projectRoot: root, host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const pageResponse = await fetch(`${app.url}/api/pages/01-agent-loop/01`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  const baseResponse = await fetch(`${app.url}${page.baseUrl}`);
  assert.equal(baseResponse.status, 200);
  assert.equal(baseResponse.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await baseResponse.arrayBuffer()), baseBytes);
  page.layout.items[0].width = 145;
  page.layout.items[0].height = 260;

  const saveResponse = await fetch(`${app.url}/api/pages/01-agent-loop/01/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(page.layout),
  });
  assert.equal(saveResponse.status, 200);

  const reloaded = await (await fetch(`${app.url}/api/pages/01-agent-loop/01`)).json();
  assert.equal(reloaded.layout.items[0].width, 145);
  assert.equal(reloaded.layout.items[0].height, 260);

  const webp = Buffer.from("RIFF-e2e-WEBP");
  const png = Buffer.from("PNG-e2e");
  assert.equal((await fetch(`${app.url}/api/pages/01-agent-loop/01/export/webp`, { method: "POST", body: webp })).status, 200);
  assert.equal((await fetch(`${app.url}/api/pages/01-agent-loop/01/export/png`, { method: "POST", body: png })).status, 200);
  assert.deepEqual(await readFile(path.join(exportsDir, "page-01-final.webp")), webp);
  assert.deepEqual(await readFile(path.join(exportsDir, "page-01-final.png")), png);
});

test("HTTP generated appendix workflow persists edits and exports without a base manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lettering-generated-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pageDir = path.join(root, "docs/story/chapters/01-agent-loop/pages");
  const characterDir = path.join(root, "docs/story/assets/characters");
  const sheetDir = path.join(characterDir, "wakaba-mutsu");
  const exportsDir = path.join(root, ".story-assets/exports/01-agent-loop/pages");
  await mkdir(pageDir, { recursive: true });
  await mkdir(sheetDir, { recursive: true });
  const portraitId = "wakaba-mutsu-gentle-v1";
  const initial = {
    version: 1,
    chapter: "01-agent-loop",
    page: "12",
    source: { kind: "generated", width: 400, height: 600, background: "#f7f5ef" },
    items: [{
      id: "P01", type: "portrait", portraitId,
      x: 20, y: 20, width: 120, height: 120, shape: "rounded", grayscale: true,
    }],
  };
  const portraits = {
    [portraitId]: {
      label: "若叶睦 · 温柔", character: "若叶睦", expression: "温柔",
      file: "wakaba-mutsu/character-sheet-v1.webp",
      crop: { x: 1050, y: 0, width: 390, height: 390 },
    },
  };
  const portraitBytes = Buffer.from("RIFF-e2e-portrait-WEBP");
  await writeFile(path.join(pageDir, "page-12-lettering.json"), JSON.stringify(initial));
  await writeFile(path.join(characterDir, "portraits.json"), JSON.stringify(portraits));
  await writeFile(path.join(sheetDir, "character-sheet-v1.webp"), portraitBytes);

  const app = await createLetteringServer({ projectRoot: root, host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const response = await fetch(`${app.url}/api/pages/01-agent-loop/12`);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.baseUrl, null);
  assert.equal(page.portraits[portraitId].imageUrl, `/api/portraits/${portraitId}/image`);
  assert.deepEqual(
    Buffer.from(await (await fetch(`${app.url}${page.portraits[portraitId].imageUrl}`)).arrayBuffer()),
    portraitBytes,
  );

  page.layout.items[0].width = 150;
  const save = await fetch(`${app.url}/api/pages/01-agent-loop/12/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(page.layout),
  });
  assert.equal(save.status, 200);
  const reloaded = await (await fetch(`${app.url}/api/pages/01-agent-loop/12`)).json();
  assert.equal(reloaded.layout.items[0].width, 150);

  const png = Buffer.from("PNG-generated-e2e");
  assert.equal(
    (await fetch(`${app.url}/api/pages/01-agent-loop/12/export/png`, { method: "POST", body: png })).status,
    200,
  );
  assert.deepEqual(await readFile(path.join(exportsDir, "page-12-final.png")), png);
});
