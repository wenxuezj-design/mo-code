function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function displayToSourcePoint(point, scale) {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("scale must be greater than zero");
  return {
    x: Math.round(finite(point.x) / scale),
    y: Math.round(finite(point.y) / scale),
  };
}

export function isRectFullyVisible(rect, viewport, { margin = 0, occludedTop = viewport.top } = {}) {
  const visibleTop = Math.max(viewport.top, occludedTop) + margin;
  return (
    rect.top >= visibleTop &&
    rect.right <= viewport.right - margin &&
    rect.bottom <= viewport.bottom - margin &&
    rect.left >= viewport.left + margin
  );
}

export function moveRegion(region, displayDelta, source, scale = 1) {
  const delta = displayToSourcePoint(displayDelta, scale);
  return {
    ...region,
    x: clamp(Math.round(region.x + delta.x), 0, Math.max(0, source.width - region.width)),
    y: clamp(Math.round(region.y + delta.y), 0, Math.max(0, source.height - region.height)),
  };
}

export function resizeRegion(region, handle, displayDelta, source, minimum = { width: 40, height: 40 }, scale = 1) {
  if (!new Set(["n", "ne", "e", "se", "s", "sw", "w", "nw"]).has(handle)) {
    throw new Error(`Unknown resize handle: ${handle}`);
  }
  const delta = displayToSourcePoint(displayDelta, scale);
  const originalRight = region.x + region.width;
  const originalBottom = region.y + region.height;
  let left = region.x;
  let right = originalRight;
  let top = region.y;
  let bottom = originalBottom;

  if (handle.includes("w")) left = clamp(region.x + delta.x, 0, originalRight - minimum.width);
  if (handle.includes("e")) right = clamp(originalRight + delta.x, region.x + minimum.width, source.width);
  if (handle.includes("n")) top = clamp(region.y + delta.y, 0, originalBottom - minimum.height);
  if (handle.includes("s")) bottom = clamp(originalBottom + delta.y, region.y + minimum.height, source.height);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}
