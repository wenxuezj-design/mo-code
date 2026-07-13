import path from "node:path";

const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE_PATTERN = /^\d{2}$/;

export function assertSafeSegment(value, label) {
  if (typeof value !== "string" || !SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function assertPage(value) {
  if (typeof value !== "string" || !PAGE_PATTERN.test(value)) {
    throw new Error(`Invalid page: ${String(value)}`);
  }
  return value;
}

function within(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes allowed root`);
  }
  return resolvedCandidate;
}

export function resolvePagePaths({ projectRoot, chapter, page }) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("projectRoot must be a non-empty string");
  }
  const safeChapter = assertSafeSegment(chapter, "chapter");
  const safePage = assertPage(page);
  const root = path.resolve(projectRoot);
  const layoutRoot = path.join(root, "docs", "story", "chapters");
  const pageRoot = within(
    layoutRoot,
    path.join(layoutRoot, safeChapter, "pages"),
    "Layout path",
  );
  const cacheRoot = path.join(root, ".story-assets", "cache");
  const pageCacheRoot = within(
    cacheRoot,
    path.join(cacheRoot, safeChapter),
    "Cache path",
  );
  const exportsRoot = path.join(root, ".story-assets", "exports");
  const pageExportsRoot = within(
    exportsRoot,
    path.join(exportsRoot, safeChapter, "pages"),
    "Export path",
  );

  return {
    projectRoot: root,
    pageRoot,
    baseWebp: path.join(pageCacheRoot, `page-${safePage}-base.webp`),
    layoutJson: path.join(pageRoot, `page-${safePage}-lettering.json`),
    finalWebp: path.join(pageExportsRoot, `page-${safePage}-final.webp`),
    finalPng: path.join(pageExportsRoot, `page-${safePage}-final.png`),
  };
}
