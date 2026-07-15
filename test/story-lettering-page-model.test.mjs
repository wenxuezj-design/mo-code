import test from "node:test";
import assert from "node:assert/strict";

import {
  isGeneratedSource,
  isPortraitItem,
  isTextItem,
  validatePageLayout,
} from "../docs/story/tools/lettering/lib/page-model.mjs";

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

function validPortrait(overrides = {}) {
  return {
    id: "P01",
    type: "portrait",
    portraitId: "wakaba-mortis-confused-v1",
    x: 40,
    y: 40,
    width: 160,
    height: 160,
    shape: "circle",
    grayscale: true,
    ...overrides,
  };
}

function layoutWithPortrait(overrides = {}) {
  const layout = validLayout();
  layout.items = [validPortrait(overrides)];
  return layout;
}

test("validatePageLayout accepts source-pixel lettering data", () => {
  const layout = validatePageLayout(validLayout());

  assert.equal(layout.items[0].width, 180);
  assert.notEqual(layout, validLayout());
});

test("validatePageLayout accepts a generated appendix source", () => {
  const layout = validLayout();
  layout.source = { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" };
  assert.equal(validatePageLayout(layout).source.kind, "generated");
});

test("validatePageLayout rejects an invalid generated background", () => {
  const layout = validLayout();
  layout.source = { kind: "generated", width: 1240, height: 1754, background: "paper" };
  assert.throws(() => validatePageLayout(layout), /background/);
});

test("validatePageLayout rejects an explicit unknown source kind", () => {
  const layout = validLayout();
  layout.source = { kind: "image", file: "page-01-base.webp", width: 864, height: 1821 };
  assert.throws(() => validatePageLayout(layout), /layout\.source\.kind/);
});

test("validatePageLayout accepts text appearance and portrait items", () => {
  const layout = validLayout();
  layout.items[0].appearance = "dialogue";
  layout.items.push({
    id: "P01", type: "portrait", portraitId: "wakaba-mortis-confused-v1",
    x: 40, y: 40, width: 160, height: 160, shape: "circle", grayscale: true,
  });
  assert.equal(validatePageLayout(layout).items[1].type, "portrait");
});

test("validatePageLayout accepts monochrome tone appearances", () => {
  for (const appearance of ["tone-light", "tone-dots", "tone-lines", "tone-dark"]) {
    const layout = validLayout();
    layout.items[0].appearance = appearance;
    assert.equal(validatePageLayout(layout).items[0].appearance, appearance);
  }
});

test("validatePageLayout rejects an invalid text appearance", () => {
  const layout = validLayout();
  layout.items[0].appearance = "bubble";
  assert.throws(() => validatePageLayout(layout), /appearance/);
});

test("validatePageLayout rejects a missing portraitId", () => {
  const layout = layoutWithPortrait();
  delete layout.items[0].portraitId;
  assert.throws(() => validatePageLayout(layout), /portraitId/);
});

test("validatePageLayout rejects an invalid portraitId", () => {
  const layout = layoutWithPortrait({ portraitId: "   " });
  assert.throws(() => validatePageLayout(layout), /portraitId/);
});

test("validatePageLayout rejects a missing portrait shape", () => {
  const layout = layoutWithPortrait();
  delete layout.items[0].shape;
  assert.throws(() => validatePageLayout(layout), /shape/);
});

test("validatePageLayout rejects an invalid portrait shape", () => {
  const layout = layoutWithPortrait({ shape: "square" });
  assert.throws(() => validatePageLayout(layout), /shape/);
});

test("validatePageLayout rejects a missing portrait grayscale flag", () => {
  const layout = layoutWithPortrait();
  delete layout.items[0].grayscale;
  assert.throws(() => validatePageLayout(layout), /grayscale/);
});

test("validatePageLayout rejects an invalid portrait grayscale flag", () => {
  const layout = layoutWithPortrait({ grayscale: "yes" });
  assert.throws(() => validatePageLayout(layout), /grayscale/);
});

test("validatePageLayout rejects portraits outside source bounds", () => {
  const layout = layoutWithPortrait({ x: 800, width: 100 });
  assert.throws(() => validatePageLayout(layout), /outside source bounds/);
});

test("validatePageLayout rejects an unknown item type", () => {
  const layout = validLayout();
  layout.items[0].type = "image";
  assert.throws(() => validatePageLayout(layout), /type is invalid/);
});

test("isTextItem recognizes only text discriminants", () => {
  for (const type of ["speech", "narration", "technical"]) {
    assert.equal(isTextItem({ type }), true);
  }
  assert.equal(isTextItem({ type: "portrait" }), false);
  assert.equal(isTextItem({ type: "image" }), false);
  assert.equal(isTextItem(null), false);
  assert.equal(isTextItem([]), false);
});

test("isPortraitItem recognizes only the portrait discriminant", () => {
  assert.equal(isPortraitItem({ type: "portrait" }), true);
  assert.equal(isPortraitItem({ type: "speech" }), false);
  assert.equal(isPortraitItem({ type: "image" }), false);
  assert.equal(isPortraitItem(null), false);
  assert.equal(isPortraitItem([]), false);
});

test("isGeneratedSource recognizes only the generated discriminant", () => {
  assert.equal(isGeneratedSource({ kind: "generated" }), true);
  assert.equal(isGeneratedSource({ file: "page.webp" }), false);
  assert.equal(isGeneratedSource({ kind: "image" }), false);
  assert.equal(isGeneratedSource(null), false);
  assert.equal(isGeneratedSource([]), false);
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
