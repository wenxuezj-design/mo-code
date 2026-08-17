const DEFAULT_CHAPTER = "01-agent-loop";
const DEFAULT_PAGE = "01";
const CHAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE_PATTERN = /^\d{2}$/;

function requireRouteSegment(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

export function parseEditorRoute(search = "") {
  const query = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(search);
  const chapter = query.get("chapter") ?? DEFAULT_CHAPTER;
  const page = query.get("page") ?? DEFAULT_PAGE;
  return {
    chapter: requireRouteSegment(chapter, "chapter", CHAPTER_PATTERN),
    page: requireRouteSegment(page, "page", PAGE_PATTERN),
  };
}

export function buildPageApiRoot({ chapter, page }) {
  const safeChapter = requireRouteSegment(chapter, "chapter", CHAPTER_PATTERN);
  const safePage = requireRouteSegment(page, "page", PAGE_PATTERN);
  return `/api/pages/${encodeURIComponent(safeChapter)}/${encodeURIComponent(safePage)}`;
}
