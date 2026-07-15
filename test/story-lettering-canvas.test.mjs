import test from "node:test";
import assert from "node:assert/strict";

import {
  drawLettering,
  drawPage,
  verticalGlyph,
} from "../docs/story/tools/lettering/lib/canvas-export.mjs";

function textItem(overrides = {}) {
  return {
    id: "T01",
    type: "narration",
    speaker: null,
    text: "同一颗心脏",
    direction: "horizontal",
    x: 40,
    y: 60,
    width: 300,
    height: 100,
    padding: 12,
    fontFamily: "PingFang SC",
    fontSize: 28,
    minFontSize: 18,
    fontWeight: 600,
    lineHeight: 1.25,
    align: "center",
    ...overrides,
  };
}

function pageLayout({ source, items }) {
  return {
    version: 1,
    chapter: "01-agent-loop",
    page: "12",
    source,
    items,
  };
}

function recordingContext() {
  const events = [];
  const states = [];
  let currentPath = null;
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    filter: "none",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineCap: "",
    lineWidth: 0,
    measureText(text) {
      const fontSize = Number(this.font.match(/ (\d+)px /)?.[1] ?? 0);
      return { width: [...text].length * fontSize };
    },
    save() {
      states.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        filter: this.filter,
        lineWidth: this.lineWidth,
      });
      events.push({ type: "save" });
    },
    restore() {
      Object.assign(this, states.pop());
      events.push({ type: "restore" });
    },
    beginPath() {
      currentPath = null;
      events.push({ type: "beginPath" });
    },
    moveTo(x, y) {
      currentPath = { shape: "line", points: [{ x, y }] };
      events.push({ type: "moveTo", x, y });
    },
    lineTo(x, y) {
      currentPath?.points.push({ x, y });
      events.push({ type: "lineTo", x, y });
    },
    arc(x, y, radius, startAngle, endAngle) {
      currentPath = { shape: "circle", x, y, radius, startAngle, endAngle };
      events.push({ type: "arc", ...currentPath });
    },
    roundRect(x, y, width, height, radius) {
      currentPath = { shape: "rounded", x, y, width, height, radius };
      events.push({ type: "roundRect", ...currentPath });
    },
    clip() { events.push({ type: "clip", path: currentPath }); },
    fill() { events.push({ type: "fill", path: currentPath, fillStyle: this.fillStyle }); },
    stroke() { events.push({
      type: "stroke",
      path: currentPath,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
    }); },
    fillRect(x, y, width, height) {
      events.push({ type: "fillRect", x, y, width, height, fillStyle: this.fillStyle });
    },
    drawImage(...args) {
      events.push({ type: "drawImage", args, filter: this.filter });
    },
    fillText(text, x, y) {
      events.push({ type: "fillText", text, x, y, fillStyle: this.fillStyle });
    },
  };
  return { ctx, events };
}

test("drawPage fills generated paper before drawing content", () => {
  const { ctx, events } = recordingContext();
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [textItem()],
  });

  drawPage(ctx, { image: null, layout, portraits: {} });

  const paperIndex = events.findIndex((event) => event.type === "fillRect");
  const textIndex = events.findIndex((event) => event.type === "fillText");
  assert.ok(paperIndex >= 0 && paperIndex < textIndex);
  assert.deepEqual(events[paperIndex], {
    type: "fillRect",
    x: 0,
    y: 0,
    width: 1240,
    height: 1754,
    fillStyle: "#f7f5ef",
  });
});

test("drawPage clips and crops a portrait item", () => {
  const { ctx, events } = recordingContext();
  const sheet = { name: "wakaba-mortis-sheet" };
  const crop = { x: 835, y: 80, width: 380, height: 380 };
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [{
      id: "P01",
      type: "portrait",
      portraitId: "wakaba-mortis-confused-v1",
      x: 40,
      y: 60,
      width: 160,
      height: 160,
      shape: "circle",
      grayscale: true,
    }],
  });

  drawPage(ctx, {
    image: null,
    layout,
    portraits: { "wakaba-mortis-confused-v1": { image: sheet, crop } },
  });

  const clipIndex = events.findIndex((event) => event.type === "clip");
  const imageIndex = events.findIndex((event) => event.type === "drawImage");
  const restoreIndex = events.findIndex((event, index) => index > imageIndex && event.type === "restore");
  const frameIndex = events.findIndex((event, index) => index > restoreIndex && event.type === "stroke");
  assert.ok(clipIndex >= 0 && clipIndex < imageIndex);
  assert.ok(imageIndex < restoreIndex && restoreIndex < frameIndex);
  assert.deepEqual(events[imageIndex].args, [
    sheet,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    40,
    60,
    160,
    160,
  ]);
  assert.equal(events[imageIndex].filter, "grayscale(1)");
  assert.equal(events[frameIndex].strokeStyle, "#101010");
});

test("drawPage rejects an unknown portrait ID", () => {
  const { ctx } = recordingContext();
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [{
      id: "P01",
      type: "portrait",
      portraitId: "unknown-v1",
      x: 40,
      y: 60,
      width: 160,
      height: 160,
      shape: "rounded",
      grayscale: false,
    }],
  });

  assert.throws(
    () => drawPage(ctx, { image: null, layout, portraits: {} }),
    /Unknown portrait ID: unknown-v1/,
  );
});

test("drawPage rejects portrait IDs inherited by a plain-object map", () => {
  const portrait = {
    image: { name: "prototype-sheet" },
    crop: { x: 0, y: 0, width: 100, height: 100 },
  };
  const cases = [
    { id: "inherited-v1", portraits: Object.create({ "inherited-v1": portrait }) },
    { id: "constructor", portraits: {} },
    { id: "__proto__", portraits: { __proto__: portrait } },
  ];

  for (const { id, portraits } of cases) {
    const { ctx } = recordingContext();
    const layout = pageLayout({
      source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
      items: [{
        id: "P01",
        type: "portrait",
        portraitId: id,
        x: 40,
        y: 60,
        width: 160,
        height: 160,
        shape: "circle",
        grayscale: false,
      }],
    });

    assert.throws(
      () => drawPage(ctx, { image: null, layout, portraits }),
      new RegExp(`Unknown portrait ID: ${id}`),
    );
  }
});

test("drawPage draws dialogue and code appearances before text", () => {
  const { ctx, events } = recordingContext();
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [
      textItem({ id: "D01", text: "为什么还要继续讲？", appearance: "dialogue", x: 40, y: 60 }),
      textItem({
        id: "C01",
        text: "model → action",
        appearance: "code",
        x: 40,
        y: 200,
        width: 500,
      }),
    ],
  });

  drawPage(ctx, { image: null, layout, portraits: {} });

  const dialogueFill = events.findIndex((event) => (
    event.type === "fill" && event.path?.x === 40 && event.path?.y === 60
  ));
  const dialogueStroke = events.findIndex((event) => (
    event.type === "stroke" && event.path?.x === 40 && event.path?.y === 60
  ));
  const dialogueText = events.findIndex((event) => event.type === "fillText" && event.text === "为什么还要继续讲？");
  assert.ok(dialogueFill >= 0 && dialogueFill < dialogueText);
  assert.ok(dialogueStroke >= 0 && dialogueStroke < dialogueText);
  assert.equal(events[dialogueFill].fillStyle, "#ffffff");
  assert.equal(events[dialogueStroke].strokeStyle, "#101010");
  assert.equal(events[dialogueText].fillStyle, "#101010");

  const codeFill = events.findIndex((event) => (
    event.type === "fill" && event.path?.x === 40 && event.path?.y === 200
  ));
  const codeText = events.findIndex((event) => event.type === "fillText" && event.text === "model → action");
  assert.ok(codeFill >= 0 && codeFill < codeText);
  assert.equal(events[codeFill].fillStyle, "#101010");
  assert.equal(events[codeText].fillStyle, "#ffffff");
});

test("drawPage applies card, inverted, label, title, and plain appearances", () => {
  const { ctx, events } = recordingContext();
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [
      textItem({ id: "D01", text: "dialogue", appearance: "dialogue", x: 20, y: 20 }),
      textItem({ id: "C01", text: "card", appearance: "card", x: 360, y: 20 }),
      textItem({ id: "I01", text: "inverted", appearance: "inverted", x: 20, y: 160 }),
      textItem({ id: "L01", text: "label", appearance: "label", x: 360, y: 160 }),
      textItem({ id: "T01", text: "title", appearance: "title", x: 20, y: 300 }),
      textItem({ id: "P01", text: "plain", appearance: "plain", x: 360, y: 300 }),
    ],
  });

  drawPage(ctx, { image: null, layout, portraits: {} });

  const roundedAt = (x, y) => events.find((event) => (
    event.type === "roundRect" && event.x === x && event.y === y
  ));
  const dialoguePath = roundedAt(20, 20);
  const cardPath = roundedAt(360, 20);
  assert.ok(dialoguePath.radius > cardPath.radius);
  assert.equal(events.find((event) => (
    event.type === "fill" && event.path?.x === 360 && event.path?.y === 20
  ))?.fillStyle, "#ffffff");

  assert.equal(events.find((event) => (
    event.type === "fill" && event.path?.x === 20 && event.path?.y === 160
  ))?.fillStyle, "#101010");
  assert.equal(events.find((event) => (
    event.type === "fill" && event.path?.x === 360 && event.path?.y === 160
  ))?.fillStyle, "#e8e8e8");
  assert.equal(events.find((event) => event.type === "fillText" && event.text === "inverted")?.fillStyle, "#ffffff");
  assert.equal(events.find((event) => event.type === "fillText" && event.text === "label")?.fillStyle, "#101010");

  assert.equal(roundedAt(20, 300), undefined);
  assert.equal(roundedAt(360, 300), undefined);
  assert.equal(events.find((event) => event.type === "fillText" && event.text === "title")?.fillStyle, "#101010");
  assert.equal(events.find((event) => event.type === "fillText" && event.text === "plain")?.fillStyle, "#101010");
});

test("drawPage applies distinct monochrome tone fills and patterns", () => {
  const { ctx, events } = recordingContext();
  const layout = pageLayout({
    source: { kind: "generated", width: 1240, height: 1754, background: "#f7f5ef" },
    items: [
      textItem({ id: "L01", text: "light", appearance: "tone-light", x: 20, y: 20 }),
      textItem({ id: "D01", text: "dots", appearance: "tone-dots", x: 360, y: 20 }),
      textItem({ id: "H01", text: "lines", appearance: "tone-lines", x: 20, y: 160 }),
      textItem({ id: "K01", text: "dark", appearance: "tone-dark", x: 360, y: 160 }),
    ],
  });

  drawPage(ctx, { image: null, layout, portraits: {} });

  const fillAt = (x, y) => events.find((event) => (
    event.type === "fill" && event.path?.x === x && event.path?.y === y
  ));
  assert.equal(fillAt(20, 20)?.fillStyle, "#f1f1f1");
  assert.equal(fillAt(360, 20)?.fillStyle, "#fafafa");
  assert.equal(fillAt(20, 160)?.fillStyle, "#f8f8f8");
  assert.equal(fillAt(360, 160)?.fillStyle, "#d4d4d4");
  assert.ok(events.some((event) => event.type === "fillRect" && event.fillStyle === "#b8b8b8"));
  assert.ok(events.some((event) => event.type === "stroke" && event.strokeStyle === "#c6c6c6"));
  for (const text of ["light", "dots", "lines", "dark"]) {
    assert.equal(events.find((event) => event.type === "fillText" && event.text === text)?.fillStyle, "#101010");
  }
});

test("vertical canvas text uses vertical presentation forms for CJK punctuation", () => {
  assert.equal(verticalGlyph("，"), "︐");
  assert.equal(verticalGlyph("、"), "︑");
  assert.equal(verticalGlyph("。"), "︒");
  assert.equal(verticalGlyph("："), "︓");
  assert.equal(verticalGlyph("；"), "︔");
  assert.equal(verticalGlyph("！"), "︕");
  assert.equal(verticalGlyph("？"), "︖");
  assert.equal(verticalGlyph("墨"), "墨");
});

test("vertical canvas text draws consecutive em dashes as one continuous vertical stroke", () => {
  const events = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineCap: "",
    lineWidth: 0,
    measureText(text) {
      const fontSize = Number(this.font.match(/ (\d+)px /)?.[1] ?? 0);
      return { width: [...text].length * fontSize };
    },
    fillText(text, x, y) { events.push({ type: "fillText", text, x, y }); },
    save() { events.push({ type: "save" }); },
    restore() { events.push({ type: "restore" }); },
    beginPath() { events.push({ type: "beginPath" }); },
    moveTo(x, y) { events.push({ type: "moveTo", x, y }); },
    lineTo(x, y) { events.push({ type: "lineTo", x, y }); },
    stroke() { events.push({ type: "stroke" }); },
  };
  const item = {
    id: "D01",
    text: "妈妈回来啦——",
    direction: "vertical",
    x: 68,
    y: 56,
    width: 112,
    height: 232,
    padding: 12,
    fontFamily: "PingFang SC",
    fontSize: 26,
    minFontSize: 16,
    fontWeight: 500,
    lineHeight: 1.25,
    align: "center",
  };

  drawLettering(context, { items: [item] });

  assert.equal(events.filter((event) => event.type === "fillText" && event.text === "—").length, 0);
  assert.equal(events.filter((event) => event.type === "stroke").length, 1);
  const move = events.find((event) => event.type === "moveTo");
  const line = events.find((event) => event.type === "lineTo");
  assert.equal(move.x, line.x);
  assert.ok(line.y - move.y > item.fontSize * 1.5);
});

test("vertical canvas glyphs use top-aligned em boxes inside the configured region", () => {
  const calls = [];
  const context = {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    measureText(text) {
      const fontSize = Number(this.font.match(/ (\d+)px /)?.[1] ?? 0);
      return { width: [...text].length * fontSize };
    },
    fillText(text, x, y) {
      calls.push({ text, x, y, font: this.font, textBaseline: this.textBaseline });
    },
  };
  const item = {
    id: "N01",
    text: "若叶墨，十三岁。\n最近没有去学校。",
    direction: "vertical",
    x: 64,
    y: 60,
    width: 124,
    height: 257,
    padding: 13,
    fontFamily: "PingFang SC",
    fontSize: 27,
    minFontSize: 18,
    fontWeight: 600,
    lineHeight: 1.2,
    align: "center",
  };

  drawLettering(context, { items: [item] });

  assert.equal(calls.length, 16);
  assert.ok(calls.every((call) => call.textBaseline === "top"));
  assert.ok(calls.every((call) => call.font.includes(" 27px ")));
  assert.equal(calls.filter((call) => call.text === "︒").length, 2);
  const bottom = Math.max(...calls.map((call) => call.y + item.fontSize));
  assert.ok(bottom <= item.y + item.height - item.padding);
});
