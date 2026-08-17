import test from "node:test";
import assert from "node:assert/strict";

import {
  fitText,
  layoutHorizontalText,
  layoutText,
  layoutVerticalText,
} from "../docs/story/tools/lettering/lib/text-fit.mjs";

const measure = (text, fontSize) => [...text].length * fontSize;

test("layoutHorizontalText wraps Chinese text inside padded width", () => {
  const result = layoutHorizontalText({
    text: "一二三四五六",
    fontSize: 20,
    width: 80,
    height: 100,
    padding: 10,
    lineHeight: 1.25,
    measure,
  });

  assert.deepEqual(result.lines, ["一二三", "四五六"]);
  assert.equal(result.overflow, false);
});

test("layoutVerticalText creates right-to-left columns", () => {
  const result = layoutVerticalText({
    text: "一二三四五六",
    fontSize: 20,
    width: 92,
    height: 80,
    padding: 10,
    lineHeight: 1.2,
  });

  assert.deepEqual(result.columns, ["一二", "三四", "五六"]);
  assert.equal(result.overflow, false);
});

test("layoutVerticalText treats newlines as explicit new columns", () => {
  const result = layoutVerticalText({
    text: "甲乙\n丙丁",
    fontSize: 20,
    width: 80,
    height: 120,
    padding: 10,
    lineHeight: 1.2,
  });

  assert.deepEqual(result.columns, ["甲乙", "丙丁"]);
});

test("layoutVerticalText uses letter spacing for rows and line height for columns", () => {
  const result = layoutVerticalText({
    text: "若叶墨，十三岁。\n最近没有去学校。",
    fontSize: 27,
    width: 124,
    height: 257,
    padding: 13,
    lineHeight: 1.2,
    letterSpacing: 0.06,
  });

  assert.deepEqual(result.columns, ["若叶墨，十三岁。", "最近没有去学校。"]);
  assert.equal(result.characterStep, 27 * 1.06);
  assert.equal(result.columnStep, 27 * 1.2);
  assert.equal(result.overflow, false);
});

test("layoutText checks the configured size without silently shrinking it", () => {
  const result = layoutText({
    direction: "horizontal",
    text: "一二三四五六七八",
    fontSize: 28,
    minFontSize: 14,
    width: 90,
    height: 80,
    padding: 10,
    lineHeight: 1.25,
    measure,
  });

  assert.equal(result.fontSize, 28);
  assert.equal(result.overflow, true);
});

test("fitText reduces font size until horizontal text fits", () => {
  const result = fitText({
    direction: "horizontal",
    text: "一二三四五六七八",
    fontSize: 28,
    minFontSize: 14,
    width: 90,
    height: 80,
    padding: 10,
    lineHeight: 1.25,
    measure,
  });

  assert.ok(result.fontSize < 28);
  assert.equal(result.overflow, false);
});

test("fitText reports overflow at minimum font size", () => {
  const result = fitText({
    direction: "vertical",
    text: "一二三四五六七八九十",
    fontSize: 20,
    minFontSize: 18,
    width: 30,
    height: 40,
    padding: 10,
    lineHeight: 1.2,
    measure,
  });

  assert.equal(result.fontSize, 18);
  assert.equal(result.overflow, true);
});

test("fitText warns when vertical text contains technical ASCII", () => {
  const result = fitText({
    direction: "vertical",
    text: "tool_use",
    fontSize: 20,
    minFontSize: 14,
    width: 100,
    height: 160,
    padding: 10,
    lineHeight: 1.2,
    measure,
  });

  assert.match(result.warning, /ASCII technical text/);
});
