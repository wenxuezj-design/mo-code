import { isRectFullyVisible, moveRegion, resizeRegion } from "/lib/layout.mjs";
import { fitText, layoutText } from "/lib/text-fit.mjs";
import { drawPage, renderPageBlob } from "/lib/canvas-export.mjs";
import { isPortraitItem, isTextItem } from "/lib/page-model.mjs";
import { createSaveQueue } from "/lib/save-queue.mjs";
import { buildPageApiRoot, parseEditorRoute } from "/lib/editor-route.mjs";

const HANDLE_NAMES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const { chapter, page } = parseEditorRoute(location.search);
const apiRoot = buildPageApiRoot({ chapter, page });
const refs = Object.fromEntries([
  "saveStatus", "checkOverflow", "exportPng", "exportWebp", "pageThumb", "pageThumbCanvas", "pageTitle", "pageMeta",
  "previousPage", "nextPage", "itemCount", "autoFit", "toggleGuides", "zoomLabel", "stageWrap", "stageToolbar", "pageFrame", "pageCanvas", "baseImage", "letteringPreview",
  "letteringLayer", "dialogueList", "textInspector", "portraitInspector", "textValue", "appearance", "portraitId", "directionHorizontal", "directionVertical",
  "fontSize", "fontSizeValue", "padding", "paddingValue", "geometry", "validationStatus", "toast",
].map((id) => [id, document.getElementById(id)]));

let layout;
let baseUrl;
let navigation = { previous: null, next: null };
let portraitMetadata = {};
let portraitRenderData = {};
let selectedId;
let displayScale = 1;
let guidesVisible = true;
let saveTimer;
let pointerSession;
let navigating = false;
const overflowIds = new Set();
const measureCanvas = document.createElement("canvas");
const measureContext = measureCanvas.getContext("2d");
const previewContext = refs.letteringPreview.getContext("2d");

function selectedItem() {
  return layout?.items.find((item) => item.id === selectedId) ?? null;
}

function setSaveState(state, label) {
  refs.saveStatus.dataset.state = state;
  refs.saveStatus.textContent = label;
}

function renderPageNavigation() {
  refs.previousPage.disabled = navigating || navigation.previous === null;
  refs.nextPage.disabled = navigating || navigation.next === null;
}

async function navigateToPage(targetPage) {
  if (targetPage === null || navigating) return;
  navigating = true;
  renderPageNavigation();
  clearTimeout(saveTimer);
  try {
    await saveLayout();
    const targetUrl = new URL(location.href);
    targetUrl.searchParams.set("chapter", chapter);
    targetUrl.searchParams.set("page", targetPage);
    location.assign(targetUrl);
  } catch (error) {
    navigating = false;
    renderPageNavigation();
    toast(`未换页：${error.message}`);
  }
}

function toast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => refs.toast.classList.remove("show"), 1800);
}

function measureItem(item, layoutFunction) {
  measureContext.font = `${item.fontWeight} ${item.fontSize}px "${item.fontFamily}", sans-serif`;
  return layoutFunction({
    ...item,
    measure: (text, fontSize) => {
      measureContext.font = `${item.fontWeight} ${fontSize}px "${item.fontFamily}", sans-serif`;
      return measureContext.measureText(text).width;
    },
  });
}

function itemLayout(item) {
  return measureItem(item, layoutText);
}

function itemFit(item) {
  return measureItem(item, fitText);
}

async function preloadPortraits() {
  const entries = await Promise.all(Object.entries(portraitMetadata).map(async ([portraitId, metadata]) => {
    const image = new Image();
    image.src = metadata.imageUrl;
    await image.decode();
    return [portraitId, { image, crop: metadata.crop }];
  }));
  portraitRenderData = Object.fromEntries(entries);
}

function renderGeneratedThumbnail() {
  if (baseUrl !== null) return;
  const canvas = refs.pageThumbCanvas;
  canvas.width = 112;
  canvas.height = Math.round(canvas.width * layout.source.height / layout.source.width);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(canvas.width / layout.source.width, canvas.height / layout.source.height);
  drawPage(context, {
    image: null,
    layout,
    portraits: portraitRenderData,
  });
  context.restore();
}

function renderPreview() {
  if (!layout) return;
  if (refs.letteringPreview.width !== layout.source.width) refs.letteringPreview.width = layout.source.width;
  if (refs.letteringPreview.height !== layout.source.height) refs.letteringPreview.height = layout.source.height;
  previewContext.clearRect(0, 0, refs.letteringPreview.width, refs.letteringPreview.height);
  drawPage(previewContext, {
    image: baseUrl === null ? null : refs.baseImage,
    layout,
    portraits: portraitRenderData,
  });
  renderGeneratedThumbnail();
}

function regionStyle(element, item) {
  element.style.left = `${item.x / layout.source.width * 100}%`;
  element.style.top = `${item.y / layout.source.height * 100}%`;
  element.style.width = `${item.width / layout.source.width * 100}%`;
  element.style.height = `${item.height / layout.source.height * 100}%`;
}

function createHandles(region) {
  for (const name of HANDLE_NAMES) {
    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.dataset.handle = name;
    handle.setAttribute("aria-label", `调整 ${name}`);
    region.append(handle);
  }
}

function renderRegions() {
  refs.letteringLayer.replaceChildren();
  for (const item of layout.items) {
    const region = document.createElement("div");
    region.className = "lettering-region";
    region.dataset.itemId = item.id;
    region.classList.toggle("selected", item.id === selectedId);
    region.classList.toggle("guided", guidesVisible);
    region.classList.toggle("overflow", overflowIds.has(item.id));
    regionStyle(region, item);

    if (item.id === selectedId) {
      const label = document.createElement("span");
      label.className = "region-id";
      label.textContent = item.id;
      region.append(label);
      createHandles(region);
    }
    region.addEventListener("pointerdown", startPointerSession);
    region.addEventListener("click", () => selectItem(item.id));
    refs.letteringLayer.append(region);
  }
}

function renderDialogueList() {
  refs.dialogueList.replaceChildren();
  for (const item of layout.items) {
    const button = document.createElement("button");
    button.className = "dialogue-item";
    button.classList.toggle("active", item.id === selectedId);
    button.classList.toggle("error", overflowIds.has(item.id));
    const meta = document.createElement("span");
    meta.className = "dialogue-meta";
    const name = document.createElement("b");
    const kind = document.createElement("span");
    const copy = document.createElement("span");
    copy.className = "dialogue-copy";
    if (isPortraitItem(item)) {
      const portrait = portraitMetadata[item.portraitId];
      name.textContent = `${item.id} · ${portrait?.character ?? "人物"}`;
      kind.textContent = "头像";
      copy.textContent = portrait?.label ?? item.portraitId;
    } else {
      name.textContent = `${item.id} · ${item.speaker || "旁白"}`;
      kind.textContent = item.direction === "vertical" ? "竖排" : "横排";
      copy.textContent = item.text;
    }
    meta.append(name, kind);
    button.append(meta, copy);
    button.addEventListener("click", () => selectItem(item.id));
    refs.dialogueList.append(button);
  }
}

function renderPortraitOptions() {
  refs.portraitId.replaceChildren();
  for (const [portraitId, metadata] of Object.entries(portraitMetadata)) {
    const option = document.createElement("option");
    option.value = portraitId;
    option.textContent = metadata.label;
    refs.portraitId.append(option);
  }
}

function renderInspector() {
  const item = selectedItem();
  if (!item) {
    refs.textInspector.hidden = true;
    refs.portraitInspector.hidden = true;
    refs.autoFit.disabled = true;
    refs.geometry.replaceChildren();
    return;
  }
  refs.textInspector.hidden = !isTextItem(item);
  refs.portraitInspector.hidden = !isPortraitItem(item);
  refs.autoFit.disabled = !isTextItem(item);
  if (isTextItem(item)) {
    refs.textValue.value = item.text;
    refs.appearance.value = item.appearance ?? "plain";
    refs.fontSize.value = item.fontSize;
    refs.fontSizeValue.textContent = `${item.fontSize}px`;
    refs.padding.value = item.padding;
    refs.paddingValue.textContent = `${item.padding}px`;
    refs.directionHorizontal.classList.toggle("active", item.direction === "horizontal");
    refs.directionVertical.classList.toggle("active", item.direction === "vertical");
  } else if (isPortraitItem(item)) {
    refs.portraitId.value = item.portraitId;
  }
  refs.geometry.innerHTML = `<span>x ${item.x}</span><span>y ${item.y}</span><span>w ${item.width}</span><span>h ${item.height}</span>`;
}

function renderAll() {
  renderPreview();
  renderRegions();
  renderDialogueList();
  renderInspector();
}

function revealSelectedRegion() {
  const region = refs.letteringLayer.querySelector(`[data-item-id="${CSS.escape(selectedId)}"]`);
  if (!region) return;
  const stageBounds = refs.stageWrap.getBoundingClientRect();
  const toolbarBounds = refs.stageToolbar.getBoundingClientRect();
  const regionBounds = region.getBoundingClientRect();
  const fullyVisible = isRectFullyVisible(regionBounds, stageBounds, {
    margin: 24,
    occludedTop: toolbarBounds.bottom,
  });
  if (!fullyVisible) {
    region.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }
}

function selectItem(id) {
  if (selectedId === id) return;
  selectedId = id;
  renderAll();
  revealSelectedRegion();
}

function updateScale() {
  if (!layout) return;
  displayScale = refs.pageCanvas.clientWidth / layout.source.width;
  refs.zoomLabel.textContent = `${Math.round(displayScale * 100)}%`;
  renderRegions();
}

function startPointerSession(event) {
  if (event.button !== 0) return;
  const region = event.currentTarget;
  const id = region.dataset.itemId;
  if (selectedId !== id) {
    selectItem(id);
    return;
  }
  const item = selectedItem();
  const handle = event.target.closest(".resize-handle")?.dataset.handle ?? null;
  pointerSession = {
    pointerId: event.pointerId,
    region,
    handle,
    start: { x: event.clientX, y: event.clientY },
    original: { x: item.x, y: item.y, width: item.width, height: item.height },
  };
  region.setPointerCapture(event.pointerId);
  event.preventDefault();
}

refs.letteringLayer.addEventListener("pointermove", (event) => {
  if (!pointerSession || event.pointerId !== pointerSession.pointerId) return;
  const delta = { x: event.clientX - pointerSession.start.x, y: event.clientY - pointerSession.start.y };
  const item = selectedItem();
  const updated = pointerSession.handle
    ? resizeRegion(pointerSession.original, pointerSession.handle, delta, layout.source, { width: 40, height: 40 }, displayScale)
    : moveRegion(pointerSession.original, delta, layout.source, displayScale);
  Object.assign(item, updated);
  regionStyle(pointerSession.region, item);
  renderPreview();
  renderInspector();
  setSaveState("dirty", "未保存");
});

function finishPointerSession(event) {
  if (!pointerSession || event.pointerId !== pointerSession.pointerId) return;
  pointerSession = null;
  scheduleSave();
  renderDialogueList();
}
refs.letteringLayer.addEventListener("pointerup", finishPointerSession);
refs.letteringLayer.addEventListener("pointercancel", finishPointerSession);

function scheduleSave() {
  setSaveState("dirty", "未保存");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveLayout().catch(() => {});
  }, 400);
}

async function persistLayout(snapshot) {
  setSaveState("saving", "保存中");
  try {
    const response = await fetch(`${apiRoot}/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: snapshot,
    });
    if (!response.ok) throw new Error((await response.json()).message || "保存失败");
    setSaveState("saved", "已保存");
  } catch (error) {
    setSaveState("error", error.message);
    throw error;
  }
}

const enqueueSave = createSaveQueue(persistLayout);

function saveLayout() {
  return enqueueSave(JSON.stringify(layout));
}

function checkAllOverflow({ announce = true } = {}) {
  overflowIds.clear();
  for (const item of layout.items) {
    if (!isTextItem(item)) continue;
    if (itemLayout(item).overflow) overflowIds.add(item.id);
  }
  refs.validationStatus.textContent = overflowIds.size ? `${overflowIds.size} 个文字区域溢出` : "没有文字溢出";
  renderRegions();
  renderDialogueList();
  if (announce) toast(overflowIds.size ? `发现 ${overflowIds.size} 个溢出区域` : "检查完成：没有溢出");
  return overflowIds.size;
}

function autoFitSelected() {
  const item = selectedItem();
  if (!isTextItem(item)) return;
  const fitted = itemFit(item);
  item.fontSize = fitted.fontSize;
  renderAll();
  checkAllOverflow({ announce: false });
  scheduleSave();
  toast(fitted.overflow ? "已到最小字号，仍然溢出" : `字号已调整为 ${fitted.fontSize}px`);
}

async function exportFormat(format) {
  const button = format === "png" ? refs.exportPng : refs.exportWebp;
  button.disabled = true;
  try {
    await saveLayout();
    if (checkAllOverflow({ announce: false })) throw new Error("存在文字溢出，请先调整");
    const blob = await renderPageBlob({
      image: baseUrl === null ? null : refs.baseImage,
      layout,
      portraits: portraitRenderData,
      format,
    });
    const response = await fetch(`${apiRoot}/export/${format}`, { method: "POST", body: blob });
    if (!response.ok) throw new Error((await response.json()).message || "导出失败");
    toast(`${format.toUpperCase()} 已写入约定路径`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function exportPageForAutomation({ formats = ["png", "webp"] } = {}) {
  const selectedFormats = [...new Set(formats)];
  if (
    selectedFormats.length === 0 ||
    selectedFormats.some((format) => format !== "png" && format !== "webp")
  ) {
    throw new Error("自动导出格式只能是 PNG 或 WebP");
  }

  await startPromise;
  await document.fonts.ready;
  await saveLayout();
  if (refs.saveStatus.dataset.state === "error") throw new Error(refs.saveStatus.textContent);
  if (checkAllOverflow({ announce: false })) throw new Error("存在文字溢出，请先调整");

  const exported = [];
  for (const format of selectedFormats) {
    const blob = await renderPageBlob({
      image: baseUrl === null ? null : refs.baseImage,
      layout,
      portraits: portraitRenderData,
      format,
    });
    const response = await fetch(`${apiRoot}/export/${format}`, { method: "POST", body: blob });
    if (!response.ok) throw new Error((await response.json()).message || `${format} 导出失败`);
    exported.push({ format, bytes: blob.size });
  }
  return { chapter, page, exported };
}

function changeSelected(mutator) {
  const item = selectedItem();
  if (!item) return;
  mutator(item);
  renderAll();
  scheduleSave();
}

function changeSelectedText(mutator) {
  const item = selectedItem();
  if (!isTextItem(item)) return;
  changeSelected(mutator);
}

refs.textValue.addEventListener("input", () => {
  const item = selectedItem();
  if (!isTextItem(item)) return;
  item.text = refs.textValue.value;
  renderPreview();
  renderRegions();
  renderDialogueList();
  scheduleSave();
});
refs.appearance.addEventListener("change", () => changeSelectedText((item) => { item.appearance = refs.appearance.value; }));
refs.portraitId.addEventListener("change", () => {
  const item = selectedItem();
  if (!isPortraitItem(item)) return;
  changeSelected((selected) => { selected.portraitId = refs.portraitId.value; });
});
refs.directionHorizontal.addEventListener("click", () => changeSelectedText((item) => { item.direction = "horizontal"; }));
refs.directionVertical.addEventListener("click", () => changeSelectedText((item) => { item.direction = "vertical"; }));
refs.fontSize.addEventListener("input", () => changeSelectedText((item) => { item.fontSize = Number(refs.fontSize.value); }));
refs.padding.addEventListener("input", () => changeSelectedText((item) => { item.padding = Number(refs.padding.value); }));
refs.autoFit.addEventListener("click", autoFitSelected);
refs.checkOverflow.addEventListener("click", () => checkAllOverflow());
refs.toggleGuides.addEventListener("click", () => { guidesVisible = !guidesVisible; refs.toggleGuides.classList.toggle("active", guidesVisible); renderRegions(); });
refs.exportWebp.addEventListener("click", () => exportFormat("webp"));
refs.exportPng.addEventListener("click", () => exportFormat("png"));
refs.previousPage.addEventListener("click", () => navigateToPage(navigation.previous));
refs.nextPage.addEventListener("click", () => navigateToPage(navigation.next));

async function start() {
  const response = await fetch(apiRoot);
  if (!response.ok) throw new Error((await response.json()).message || "页面载入失败");
  ({ layout, baseUrl, portraits: portraitMetadata, navigation } = await response.json());
  navigation ??= { previous: null, next: null };
  portraitMetadata ??= {};
  selectedId = layout.items[0]?.id;
  renderPortraitOptions();
  refs.baseImage.hidden = baseUrl === null;
  refs.pageThumb.hidden = baseUrl === null;
  refs.pageThumbCanvas.hidden = baseUrl !== null;
  if (baseUrl !== null) {
    refs.baseImage.src = baseUrl;
    refs.pageThumb.src = baseUrl;
    await refs.baseImage.decode();
  } else {
    refs.baseImage.removeAttribute("src");
    refs.pageThumb.removeAttribute("src");
  }
  await preloadPortraits();
  await Promise.all(layout.items.map((item) => isTextItem(item)
    ? document.fonts.load(
      `${item.fontWeight} ${item.fontSize}px "${item.fontFamily}"`,
      item.text,
    )
    : Promise.resolve()));
  renderPreview();
  refs.pageCanvas.style.aspectRatio = `${layout.source.width} / ${layout.source.height}`;
  refs.pageTitle.textContent = `第 ${Number(layout.page)} 页`;
  refs.pageMeta.textContent = `${layout.items.length} 个图层\n${layout.source.width} × ${layout.source.height}`;
  refs.itemCount.textContent = layout.items.length;
  renderPageNavigation();
  setSaveState("saved", "已保存");
  new ResizeObserver(updateScale).observe(refs.pageCanvas);
  updateScale();
  renderDialogueList();
  renderInspector();
  checkAllOverflow({ announce: false });
}

const startPromise = start();
window.__storyExportPage = exportPageForAutomation;
startPromise.catch((error) => {
  setSaveState("error", error.message);
  refs.validationStatus.textContent = error.message;
});
