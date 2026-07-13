import test from "node:test";
import assert from "node:assert/strict";

import { validatePageLayout } from "../docs/story/tools/lettering/lib/page-model.mjs";

function validLayout() {
  return {
    version: 1,
    chapter: "01-agent-loop",
    page: "01",
    source: { file: "page-01-base.webp", width: 864, height: 1821 },
    items: [
      {
        id: "D01",
        type: "speech",
        speaker: "若叶墨",
        text: "小白，你看得懂吗？",
        direction: "horizontal",
        x: 48,
        y: 700,
        width: 180,
        height: 160,
        padding: 12,
        fontFamily: "PingFang SC",
        fontSize: 30,
        minFontSize: 18,
        fontWeight: 500,
        lineHeight: 1.35,
        align: "center",
      },
    ],
  };
}

test("validatePageLayout accepts source-pixel lettering data", () => {
  const layout = validatePageLayout(validLayout());

  assert.equal(layout.items[0].width, 180);
  assert.notEqual(layout, validLayout());
});
test("validatePageLayout rejects regions outside the source image", () => {
  const layout = validLayout();
  layout.items[0] = { ...layout.items[0], x: 850, width: 40 };

  assert.throws(() => validatePageLayout(layout), /outside source bounds/);
});

test("validatePageLayout rejects duplicate item ids", () => {
  const layout = validLayout();
  layout.items.push({ ...layout.items[0] });

  assert.throws(() => validatePageLayout(layout), /Duplicate item id: D01/);
});

test("validatePageLayout rejects empty text", () => {
  const layout = validLayout();
  layout.items[0].text = "   ";

  assert.throws(() => validatePageLayout(layout), /text must be non-empty/);
});
