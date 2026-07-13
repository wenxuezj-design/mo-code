import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../docs/story/tools/lettering/", import.meta.url);

test("editor exposes the complete lettering workflow without a file picker", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app.js", root), "utf8"),
    readFile(new URL("styles.css", root), "utf8"),
  ]);

  assert.match(html, /id="pageCanvas"/);
  assert.match(html, /id="letteringPreview"/);
  assert.match(html, /id="dialogueList"/);
  assert.match(html, /id="directionHorizontal"/);
  assert.match(html, /id="directionVertical"/);
  assert.match(html, /id="fontSize"/);
  assert.match(html, /id="autoFit"/);
  assert.match(html, /id="checkOverflow"/);
  assert.match(html, /id="exportWebp"/);
  assert.match(html, /id="exportPng"/);
  assert.doesNotMatch(html, /type=["']file["']/);
  assert.match(app, /const HANDLE_NAMES = \["n", "ne", "e", "se", "s", "sw", "w", "nw"\]/);
  assert.match(app, /PUT/);
  assert.match(app, /exportFormat\("webp"\)/);
  assert.match(app, /exportFormat\("png"\)/);
  assert.match(app, /drawLettering\(previewContext, layout\)/);
  assert.match(app, /refs\.textValue\.addEventListener\("input", \(\) => \{[\s\S]*?renderPreview\(\);[\s\S]*?\}\);/);
  assert.match(app, /await Promise\.all\(layout\.items\.map[\s\S]*?renderPreview\(\);/);
  assert.match(
    app,
    /saveTimer = setTimeout\([\s\S]*?saveLayout\(\)\.catch[\s\S]*?400\);/,
    "background autosave must handle the rejection after recording its error state",
  );
  assert.match(
    app,
    /catch \(error\) \{[\s\S]*?setSaveState\("error", error\.message\);[\s\S]*?throw error;[\s\S]*?\}/,
    "saveLayout must reject so manual and automated exports stop before rendering",
  );
  assert.match(styles, /\.resize-handle/);
  assert.match(styles, /\.lettering-preview/);
});
