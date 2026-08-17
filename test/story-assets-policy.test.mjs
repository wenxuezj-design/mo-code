import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  encoding: "utf8",
}).trim();

function isIgnored(relativePath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", relativePath],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    assert.fail(result.stderr || `git check-ignore exited with ${result.status}`);
  }
  return result.status === 0;
}

test("Git ignores story binary assets with lowercase and uppercase extensions", () => {
  const extensions = [
    "png", "jpg", "jpeg", "webp", "gif", "avif", "tif", "tiff",
    "psd", "clip", "kra", "pdf", "cbz", "zip",
  ];

  for (const extension of extensions) {
    for (const spelling of [extension, extension.toUpperCase()]) {
      const candidate = `docs/story/policy-probe/nested/asset.${spelling}`;
      assert.equal(isIgnored(candidate), true, `${candidate} should be ignored`);
    }
  }

  for (const candidate of [
    "docs/story/asset.WeBp",
    "docs/story/asset.PNG",
  ]) {
    assert.equal(isIgnored(candidate), true, `${candidate} should be ignored`);
  }
});

test("Git keeps story Markdown, JSON, and JavaScript files eligible for tracking", () => {
  for (const extension of ["md", "json", "js", "MD", "JSON", "JS"]) {
    const candidate = `docs/story/policy-probe/nested/source.${extension}`;
    assert.equal(isIgnored(candidate), false, `${candidate} should not be ignored`);
  }
});

test("Git ignores every file below the local story asset directory", () => {
  for (const candidate of [
    ".story-assets/cache/01-agent-loop/page-01-base.webp",
    ".story-assets/exports/01-agent-loop/web/index.html",
    ".story-assets/exports/01-agent-loop/metadata.json",
  ]) {
    assert.equal(isIgnored(candidate), true, `${candidate} should be ignored`);
  }
});
