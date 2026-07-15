import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPortraitCatalog,
  resolvePortraitImagePath,
} from "../docs/story/tools/lettering/lib/portrait-catalog.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function portrait(overrides = {}) {
  return {
    label: "若叶墨 · 困惑",
    character: "若叶墨",
    expression: "困惑",
    file: "wakaba-mortis/character-sheet-v1.webp",
    crop: { x: 835, y: 80, width: 380, height: 380 },
    ...overrides,
  };
}

async function withCatalog(value, run) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "story-portraits-"));
  const catalogRoot = path.join(projectRoot, "docs", "story", "assets", "characters");
  await mkdir(catalogRoot, { recursive: true });
  await writeFile(path.join(catalogRoot, "portraits.json"), `${JSON.stringify(value, null, 2)}\n`);
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("loadPortraitCatalog loads the tracked character-sheet crops", async () => {
  const catalog = await loadPortraitCatalog({ projectRoot: PROJECT_ROOT });

  assert.deepEqual(Object.keys(catalog), [
    "wakaba-mortis-confused-v1",
    "toyokawa-sakiko-serious-v1",
    "wakaba-mutsu-gentle-v1",
    "mori-minami-cheerful-v1",
  ]);
  assert.deepEqual(catalog["wakaba-mortis-confused-v1"].crop, {
    x: 835, y: 80, width: 380, height: 380,
  });
  assert.deepEqual(catalog["toyokawa-sakiko-serious-v1"].crop, {
    x: 50, y: 20, width: 390, height: 390,
  });
  assert.deepEqual(catalog["wakaba-mutsu-gentle-v1"].crop, {
    x: 1050, y: 0, width: 390, height: 390,
  });
  assert.deepEqual(catalog["mori-minami-cheerful-v1"].crop, {
    x: 60, y: 30, width: 390, height: 390,
  });

  assert.equal(
    resolvePortraitImagePath({
      projectRoot: PROJECT_ROOT,
      portrait: catalog["wakaba-mortis-confused-v1"],
    }),
    path.join(
      PROJECT_ROOT,
      "docs",
      "story",
      "assets",
      "characters",
      "wakaba-mortis",
      "character-sheet-v1.webp",
    ),
  );
});

test("resolvePortraitImagePath rejects traversal and absolute sheet paths", () => {
  for (const file of ["../secret.webp", "/tmp/secret.webp", "C:\\temp\\secret.webp"]) {
    assert.throws(
      () => resolvePortraitImagePath({ projectRoot: PROJECT_ROOT, portrait: portrait({ file }) }),
      /safe relative path|inside the character assets directory/,
    );
  }
});

test("resolvePortraitImagePath rejects colons and Windows alternate data streams", () => {
  for (const file of [
    "wakaba-mortis/character-sheet-v1.webp:stream",
    "wakaba-mortis:stream/character-sheet-v1.webp",
  ]) {
    assert.throws(
      () => resolvePortraitImagePath({ projectRoot: PROJECT_ROOT, portrait: portrait({ file }) }),
      /safe relative path/,
    );
  }
});

test("resolvePortraitImagePath rejects a character-sheet symlink that escapes the catalog root", async (t) => {
  await withCatalog({
    "wakaba-mortis-confused-v1": portrait(),
  }, async (projectRoot) => {
    const charactersRoot = path.join(projectRoot, "docs", "story", "assets", "characters");
    const sheetDir = path.join(charactersRoot, "wakaba-mortis");
    const outsideFile = path.join(projectRoot, "outside.webp");
    await mkdir(sheetDir, { recursive: true });
    await writeFile(outsideFile, "outside");
    try {
      await symlink(outsideFile, path.join(sheetDir, "character-sheet-v1.webp"), "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("file symlinks are unavailable on this platform");
        return;
      }
      throw error;
    }

    await assert.rejects(
      Promise.resolve().then(() => resolvePortraitImagePath({
        projectRoot,
        portrait: portrait(),
      })),
      /outside the character assets directory/,
    );
  });
});

test("loadPortraitCatalog rejects duplicate character-sheet crops", async () => {
  await withCatalog({
    "wakaba-mortis-confused-v1": portrait(),
    "wakaba-mortis-confused-copy-v1": portrait({ label: "若叶墨 · 困惑副本" }),
  }, async (projectRoot) => {
    await assert.rejects(() => loadPortraitCatalog({ projectRoot }), /duplicate crop/i);
  });
});

test("loadPortraitCatalog rejects malformed crop rectangles", async () => {
  for (const crop of [
    { x: 835, y: 80, width: 0, height: 380 },
    { x: -1, y: 80, width: 380, height: 380 },
    { x: 835.5, y: 80, width: 380, height: 380 },
    { x: 835, y: 80, width: 380 },
  ]) {
    await withCatalog({
      "wakaba-mortis-confused-v1": portrait({ crop }),
    }, async (projectRoot) => {
      await assert.rejects(() => loadPortraitCatalog({ projectRoot }), /crop/);
    });
  }
});

test("unknown portrait IDs cannot resolve an image path", async () => {
  const catalog = await loadPortraitCatalog({ projectRoot: PROJECT_ROOT });

  assert.throws(
    () => resolvePortraitImagePath({ projectRoot: PROJECT_ROOT, portrait: catalog["unknown-v1"] }),
    /portrait must be an object/,
  );
});
