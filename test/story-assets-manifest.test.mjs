import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadAssetManifest,
  resolveAssetCachePath,
  resolvePageAsset,
  validateAssetManifest,
} from "../docs/story/tools/lettering/lib/asset-manifest.mjs";

function validManifest() {
  return {
    version: 1,
    chapter: "01-agent-loop",
    pages: {
      "01": {
        base: {
          remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.webp",
          cacheFile: "page-01-base.webp",
          sha256: "a".repeat(64),
          bytes: 315524,
          width: 864,
          height: 1821,
        },
      },
    },
  };
}

test("validateAssetManifest accepts the fixed version 1 schema", () => {
  const input = validManifest();
  const manifest = validateAssetManifest(input);

  assert.deepEqual(manifest, input);
  assert.notEqual(manifest, input);
  assert.notEqual(manifest.pages["01"].base, input.pages["01"].base);
});

test("loadAssetManifest reads and validates the chapter manifest", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "story-manifest-"));
  const manifestPath = path.join(
    projectRoot,
    "docs/story/chapters/01-agent-loop/assets.json",
  );

  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(validManifest()), "utf8");

    assert.deepEqual(
      await loadAssetManifest({ projectRoot, chapter: "01-agent-loop" }),
      validManifest(),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("loadAssetManifest rejects a chapter mismatch from the loaded file", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "story-manifest-"));
  const manifestPath = path.join(
    projectRoot,
    "docs/story/chapters/02-context/assets.json",
  );

  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(validManifest()), "utf8");

    await assert.rejects(
      () => loadAssetManifest({ projectRoot, chapter: "02-context" }),
      /chapter.*match/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolvePageAsset rejects a chapter mismatch", () => {
  assert.throws(
    () =>
      resolvePageAsset({
        manifest: validManifest(),
        chapter: "02-context",
        page: "01",
        kind: "base",
      }),
    /chapter.*match/i,
  );
});

test("resolvePageAsset returns the requested page asset", () => {
  assert.deepEqual(
    resolvePageAsset({
      manifest: validManifest(),
      chapter: "01-agent-loop",
      page: "01",
      kind: "base",
    }),
    validManifest().pages["01"].base,
  );
});

test("validateAssetManifest rejects page asset kinds outside the fixed schema", () => {
  const manifest = validManifest();
  manifest.pages["01"].thumbnail = { ...manifest.pages["01"].base };

  assert.throws(() => validateAssetManifest(manifest), /kind|base/i);
});

test("validateAssetManifest requires base to be an own page property", () => {
  const manifest = validManifest();
  manifest.pages["01"] = Object.create({ base: manifest.pages["01"].base });

  assert.throws(() => validateAssetManifest(manifest), /base.*own|own.*base/i);
});

test("resolvePageAsset rejects inherited property names as kinds", () => {
  for (const kind of ["constructor", "toString"]) {
    assert.throws(
      () =>
        resolvePageAsset({
          manifest: validManifest(),
          chapter: "01-agent-loop",
          page: "01",
          kind,
        }),
      /kind/i,
    );
  }
});

test("validateAssetManifest rejects traversal in remotePath", () => {
  const manifest = validManifest();
  manifest.pages["01"].base.remotePath = "chapters/01-agent-loop/../secret.webp";

  assert.throws(() => validateAssetManifest(manifest), /remotePath/);
});

test("validateAssetManifest rejects URI, percent-encoded, and control-character remote paths", () => {
  const unsafePaths = [
    "https:chapters/01-agent-loop/base.webp",
    "chapters/01-agent-loop/%2e%2e/secret.webp",
    "chapters/01-agent-loop/base\u0000.webp",
  ];

  for (const remotePath of unsafePaths) {
    const manifest = validManifest();
    manifest.pages["01"].base.remotePath = remotePath;

    assert.throws(() => validateAssetManifest(manifest), /remotePath/);
  }
});

test("validateAssetManifest rejects a non-canonical SHA-256", () => {
  for (const sha256 of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
    const manifest = validManifest();
    manifest.pages["01"].base.sha256 = sha256;

    assert.throws(() => validateAssetManifest(manifest), /sha256/);
  }
});

test("validateAssetManifest rejects path separators in cacheFile", () => {
  for (const cacheFile of ["nested/page-01-base.webp", "nested\\page-01-base.webp"]) {
    const manifest = validManifest();
    manifest.pages["01"].base.cacheFile = cacheFile;

    assert.throws(() => validateAssetManifest(manifest), /cacheFile/);
  }
});

test("validateAssetManifest rejects Windows ADS and control characters in cacheFile", () => {
  for (const cacheFile of ["page-01-base.webp:stream", "page-01-base\u0000.webp"]) {
    const manifest = validManifest();
    manifest.pages["01"].base.cacheFile = cacheFile;

    assert.throws(() => validateAssetManifest(manifest), /cacheFile/);
  }
});

test("resolveAssetCachePath returns an absolute path inside the chapter cache", () => {
  const projectRoot = path.resolve("/repo");
  const asset = validManifest().pages["01"].base;

  assert.equal(
    resolveAssetCachePath({ projectRoot, chapter: "01-agent-loop", asset }),
    path.join(projectRoot, ".story-assets/cache/01-agent-loop/page-01-base.webp"),
  );
  assert.throws(
    () =>
      resolveAssetCachePath({
        projectRoot,
        chapter: "01-agent-loop",
        asset: { ...asset, cacheFile: "../escape.webp" },
      }),
    /cacheFile|escapes/i,
  );
});
