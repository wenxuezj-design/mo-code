import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

const documentPath = fileURLToPath(
  new URL("../docs/notes/0.3 System Prompt工程.md", import.meta.url),
);

test("SYSTEM_PROMPT_TEMPLATE 与文档中的静态模板保持一致", () => {
  const document = readFileSync(documentPath, "utf-8");
  const tick = String.fromCharCode(96);
  const startMarker = "export const SYSTEM_PROMPT_TEMPLATE = " + tick;
  const start = document.indexOf(startMarker);
  const end = document.indexOf(tick + ";\n" + tick.repeat(3), start + startMarker.length);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(
    SYSTEM_PROMPT_TEMPLATE,
    document.slice(start + startMarker.length, end),
  );
});
