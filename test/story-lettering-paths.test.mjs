import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { assertSafeSegment, resolvePagePaths } from "../docs/story/tools/lettering/lib/paths.mjs";

test("resolvePagePaths keeps source layout in Git and moves assets outside the story tree", () => {
  const root = "/repo";
  const result = resolvePagePaths({ projectRoot: root, chapter: "01-agent-loop", page: "01" });

  assert.equal(
    result.baseWebp,
    path.join(root, ".story-assets/cache/01-agent-loop/page-01-base.webp"),
  );
  assert.equal(
    result.layoutJson,
    path.join(root, "docs/story/chapters/01-agent-loop/pages/page-01-lettering.json"),
  );
  assert.equal(
    result.finalWebp,
    path.join(root, ".story-assets/exports/01-agent-loop/pages/page-01-final.webp"),
  );
  assert.equal(
    result.finalPng,
    path.join(root, ".story-assets/exports/01-agent-loop/pages/page-01-final.png"),
  );
  assert.ok(
    !Object.values(result).includes(
      path.join(root, "docs/story/chapters/01-agent-loop/pages/page-01-final.webp"),
    ),
  );
});

test("resolvePagePaths rejects traversal", () => {
  assert.throws(
    () => resolvePagePaths({ projectRoot: "/repo", chapter: "../secret", page: "01" }),
    /Invalid chapter/,
  );
});

test("resolvePagePaths rejects invalid page names", () => {
  assert.throws(
    () => resolvePagePaths({ projectRoot: "/repo", chapter: "01-agent-loop", page: "1" }),
    /Invalid page/,
  );
});

test("assertSafeSegment accepts lowercase kebab-case", () => {
  assert.equal(assertSafeSegment("01-agent-loop", "chapter"), "01-agent-loop");
});
