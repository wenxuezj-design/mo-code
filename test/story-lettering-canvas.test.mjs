import test from "node:test";
import assert from "node:assert/strict";

import { drawLettering, verticalGlyph } from "../docs/story/tools/lettering/lib/canvas-export.mjs";

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
