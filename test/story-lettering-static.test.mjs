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
  assert.match(html, /id="appearance"/);
  assert.match(html, /id="portraitId"/);
  assert.match(html, /id="textInspector"/);
  assert.match(html, /id="portraitInspector"/);
  assert.match(html, /id="pageThumbCanvas"/);
  assert.match(html, /id="previousPage"/);
  assert.match(html, /id="nextPage"/);
  assert.match(html, /id="autoFit"/);
  assert.match(html, /id="checkOverflow"/);
  assert.match(html, /id="exportWebp"/);
  assert.match(html, /id="exportPng"/);
  assert.doesNotMatch(html, /type=["']file["']/);
  assert.match(app, /const HANDLE_NAMES = \["n", "ne", "e", "se", "s", "sw", "w", "nw"\]/);
  assert.match(app, /PUT/);
  assert.match(app, /exportFormat\("webp"\)/);
  assert.match(app, /exportFormat\("png"\)/);
  assert.match(app, /import \{ drawPage, renderPageBlob \} from "\/lib\/canvas-export\.mjs"/);
  assert.match(app, /import \{ createSaveQueue \} from "\/lib\/save-queue\.mjs"/);
  assert.match(app, /drawPage\(previewContext, \{[\s\S]*?layout,[\s\S]*?portraits[\s\S]*?\}\)/);
  assert.match(app, /window\.__storyExportPage = exportPageForAutomation/);
  assert.match(app, /\{ layout, baseUrl, portraits: portraitMetadata, navigation \} = await response\.json\(\)/);
  assert.match(
    app,
    /async function navigateToPage\(targetPage\) \{[\s\S]*?clearTimeout\(saveTimer\);[\s\S]*?await saveLayout\(\);[\s\S]*?location\.assign\(targetUrl\);[\s\S]*?\}/,
    "page navigation must flush the pending edit before leaving the current page",
  );
  assert.match(app, /refs\.previousPage\.disabled = [^;]*navigation\.previous === null/);
  assert.match(app, /refs\.nextPage\.disabled = [^;]*navigation\.next === null/);
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

test("editor branches generated pages and text/portrait controls", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app.js", root), "utf8"),
  ]);

  assert.match(html, /<select id="appearance"/);
  assert.match(html, /<select id="portraitId"/);
  assert.match(app, /isTextItem\(item\)/);
  assert.match(app, /isPortraitItem\(item\)/);
  assert.match(app, /if \(!isTextItem\(item\)\) continue;/);
  assert.match(app, /refs\.textInspector\.hidden = !isTextItem\(item\)/);
  assert.match(app, /refs\.portraitInspector\.hidden = !isPortraitItem\(item\)/);
  assert.match(app, /refs\.baseImage\.hidden = baseUrl === null/);
  assert.match(app, /refs\.pageThumbCanvas\.hidden = baseUrl !== null/);
  assert.match(app, /image: baseUrl === null \? null : refs\.baseImage/);
  assert.match(app, /Object\.entries\(portraitMetadata\)/);
  assert.match(
    app,
    /if \(!item\) \{[\s\S]*?refs\.textInspector\.hidden = true;[\s\S]*?refs\.portraitInspector\.hidden = true;[\s\S]*?refs\.autoFit\.disabled = true;[\s\S]*?refs\.geometry\.replaceChildren\(\);[\s\S]*?return;[\s\S]*?\}/,
    "an empty generated page must not expose controls for a nonexistent item",
  );
});

test("editor keeps the stage visible while dialogue controls scroll independently", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("styles.css", root), "utf8"),
  ]);

  assert.match(html, /class="dialogue-pane"/);
  assert.match(styles, /\.app-shell\s*\{[^}]*height:\s*100dvh/s);
  assert.match(styles, /\.workspace\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.inspector-sidebar\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /\.inspector-sidebar\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.dialogue-pane\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.inspector\s*\{[^}]*overflow:\s*auto/s);
});

test("selecting a dialogue reveals its lettering region without coupling slider updates", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app.js", root), "utf8"),
  ]);

  assert.match(html, /id="stageWrap"/);
  assert.match(html, /id="stageToolbar"/);
  assert.match(app, /"stageWrap"/);
  assert.match(app, /"stageToolbar"/);
  assert.match(app, /function revealSelectedRegion\(\)/);
  assert.match(app, /isRectFullyVisible\(/);
  assert.match(
    app,
    /function selectItem\(id\) \{\s*if \(selectedId === id\) return;[\s\S]*?renderAll\(\);[\s\S]*?revealSelectedRegion\(\);[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    app,
    /function changeSelected\(mutator\) \{[\s\S]*?revealSelectedRegion\(\);[\s\S]*?\}/,
  );
});
