import test from "node:test";
import assert from "node:assert/strict";

import {
  displayToSourcePoint,
  moveRegion,
  resizeRegion,
} from "../docs/story/tools/lettering/lib/layout.mjs";

const source = { width: 864, height: 1821 };
const minimum = { width: 40, height: 40 };

test("displayToSourcePoint converts display pixels using scale", () => {
  assert.deepEqual(displayToSourcePoint({ x: 25, y: 50 }, 0.5), { x: 50, y: 100 });
});
test("moveRegion converts display delta and clamps to source bounds", () => {
  const moved = moveRegion({ x: 800, y: 1780, width: 60, height: 40 }, { x: 20, y: 20 }, source, 0.5);
  assert.deepEqual(moved, { x: 804, y: 1781, width: 60, height: 40 });
});

test("resizeRegion converts display delta to source pixels", () => {
  const region = { x: 100, y: 200, width: 200, height: 300 };
  const result = resizeRegion(region, "se", { x: 25, y: 50 }, source, minimum, 0.5);

  assert.deepEqual(result, { x: 100, y: 200, width: 250, height: 400 });
});

test("resizeRegion clamps north-west resize to page bounds", () => {
  const result = resizeRegion(
    { x: 10, y: 10, width: 100, height: 100 },
    "nw",
    { x: -50, y: -50 },
    source,
    minimum,
    1,
  );

  assert.deepEqual(result, { x: 0, y: 0, width: 110, height: 110 });
});

test("resizeRegion respects minimum size on west resize", () => {
  const result = resizeRegion(
    { x: 100, y: 100, width: 80, height: 80 },
    "w",
    { x: 200, y: 0 },
    source,
    minimum,
    1,
  );

  assert.deepEqual(result, { x: 140, y: 100, width: 40, height: 80 });
});
