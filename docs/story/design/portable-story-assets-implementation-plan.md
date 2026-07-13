# 漫画资源跨设备维护与章节导出实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任意电脑在取得 Google Drive 权限后，仅凭 Git 中的清单与排字 JSON 恢复漫画底图，并导出单页 PNG/WebP 及整章 Web/PDF/CBZ。

**Architecture:** Git 保存可审阅文本，Google Drive 保存不可变二进制资源，`.story-assets/` 是可删除的缓存与构建目录。资源模块负责清单、哈希、尺寸和 rclone；编辑器及批量导出只消费本地缓存，浏览器 Canvas `drawLettering()` 是唯一排字渲染实现。

**Tech Stack:** Node.js 24、原生 `node:test`、浏览器 Canvas、Google Chrome、rclone、`playwright-core`、`pdf-lib`、`fflate`。

## Global Constraints

- 所有新增或修改的行为必须按 RED → GREEN → REFACTOR 流程完成。
- 不修改或提交 worktree 中用户的 `.idea/` 目录。
- 不把 OAuth token、rclone 配置、服务账号文件或 Google Drive 文件 ID 写入 Git。
- 云端底图使用不可变版本名；上传完成并验证后才能更新 `assets.json`。
- 迁移期间先上传和校验，最后才用 `git rm --cached` 让已跟踪图片退出 Git。
- 所有生成物写入 `.story-assets/`，不得写回 `docs/story/`。
- 批量导出必须调用网页端 `drawLettering()`，不得另写一套文字布局算法。

---

### Task 1: 资源清单、图像元数据与缓存校验

**Files:**
- Create: `docs/story/tools/lettering/lib/asset-manifest.mjs`
- Create: `docs/story/tools/lettering/lib/image-metadata.mjs`
- Test: `test/story-assets-manifest.test.mjs`
- Test: `test/story-assets-metadata.test.mjs`

**Interfaces:**
- Produces: `validateAssetManifest(value)`、`loadAssetManifest({ projectRoot, chapter })`、`resolvePageAsset({ manifest, chapter, page, kind })`、`resolveAssetCachePath({ projectRoot, chapter, asset })`、`inspectImage(filePath)`、`verifyLocalAsset({ filePath, asset })`。

- [ ] **Step 1: 写清单失败测试**

  测试合法清单可解析；`chapter` 不匹配、`remotePath` 含 `..`、哈希不是 64 位小写十六进制、`cacheFile` 带路径分隔符时必须抛错。

- [ ] **Step 2: 运行测试并确认 RED**

  Run: `node --test test/story-assets-manifest.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `asset-manifest.mjs`.

- [ ] **Step 3: 实现清单模块**

  固定 schema 为：

  ```js
  {
    version: 1,
    chapter: "01-agent-loop",
    pages: {
      "01": {
        base: {
          remotePath: "chapters/01-agent-loop/bases/page-01-base-v1.webp",
          cacheFile: "page-01-base.webp",
          sha256: "<64 lowercase hex>",
          bytes: 315524,
          width: 864,
          height: 1821
        }
      }
    }
  }
  ```

  `resolveAssetCachePath()` 只能返回 `.story-assets/cache/<chapter>/<cacheFile>` 内部的绝对路径。

- [ ] **Step 4: 写图像元数据失败测试**

  使用最小 PNG、VP8、VP8L、VP8X fixture 验证宽高解析；使用临时文件验证 SHA-256、bytes、width、height 中任意一项不一致都会返回明确的 mismatch。

- [ ] **Step 5: 运行元数据测试并确认 RED**

  Run: `node --test test/story-assets-metadata.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `image-metadata.mjs`.

- [ ] **Step 6: 实现元数据读取和资源校验**

  `inspectImage()` 返回 `{ sha256, bytes, width, height }`；只接受 PNG 与 WebP。`verifyLocalAsset()` 成功返回元数据，失败抛出包含字段名、期望值和实际值的错误。

- [ ] **Step 7: 运行聚焦测试和完整测试**

  Run: `node --test test/story-assets-manifest.test.mjs test/story-assets-metadata.test.mjs && pnpm test`
  Expected: all tests PASS.

---

### Task 2: rclone 同步适配器与命令行

**Files:**
- Create: `docs/story/tools/lettering/lib/asset-sync.mjs`
- Create: `docs/story/tools/lettering/assets-cli.mjs`
- Test: `test/story-assets-sync.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 的清单、路径和校验接口。
- Produces: `pullPageBase({ projectRoot, chapter, page, remote, runRemoteCommand })`、`pushPageBase({ projectRoot, chapter, page, version, sourceFile, remote, runRemoteCommand })`、`runRclone(args)`。

- [ ] **Step 1: 写 pull 失败测试**

  注入 fake runner，断言远端路径为 `<remote><asset.remotePath>`；下载进入同目录临时文件；验证成功后原子替换缓存。runner 失败或哈希不符时旧缓存保持不变。

- [ ] **Step 2: 运行 pull 测试并确认 RED**

  Run: `node --test test/story-assets-sync.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `asset-sync.mjs`.

- [ ] **Step 3: 实现 pull 和 verify**

  rclone 命令固定为：

  ```text
  rclone copyto <remote><remotePath> <cache>.part-<pid>-<timestamp> --no-traverse
  ```

  验证失败时删除临时文件；成功时 `rename()` 替换缓存。

- [ ] **Step 4: 写 push 失败测试**

  断言 `version` 只接受 `v` 加正整数；远端文件名固定为 `page-<page>-base-<version>.<ext>`；runner 成功后才原子更新清单；runner 失败时清单内容逐字节不变。

- [ ] **Step 5: 运行 push 测试并确认 RED**

  Run: `node --test test/story-assets-sync.test.mjs`
  Expected: FAIL because `pushPageBase` is not exported.

- [ ] **Step 6: 实现 push、runner 和 CLI**

  CLI 支持：

  ```text
  assets-cli.mjs pull --chapter 01-agent-loop [--page 02]
  assets-cli.mjs verify --chapter 01-agent-loop [--page 02]
  assets-cli.mjs push --chapter 01-agent-loop --page 02 --version v2 --source /absolute/page.webp
  ```

  push 的 `copyto` 必须带 `--immutable --checksum`，使同名远端文件仅在内容相同的情况下复用，不允许不同内容覆盖；remote 必须在调用 rclone 前校验为安全的 `<name>:` 根名称；缺少 `STORY_RCLONE_REMOTE` 或 `rclone` 时输出可执行的安装/配置提示并以非零状态退出。

- [ ] **Step 7: 添加 package scripts 并验证**

  ```json
  {
    "story:assets:pull": "node docs/story/tools/lettering/assets-cli.mjs pull",
    "story:assets:verify": "node docs/story/tools/lettering/assets-cli.mjs verify",
    "story:assets:push": "node docs/story/tools/lettering/assets-cli.mjs push"
  }
  ```

  Run: `node --test test/story-assets-sync.test.mjs && pnpm test`
  Expected: all tests PASS.

---

### Task 3: 编辑器改用缓存，所有成品退出源码目录

**Files:**
- Modify: `docs/story/tools/lettering/lib/paths.mjs`
- Modify: `docs/story/tools/lettering/server.mjs`
- Modify: `test/story-lettering-paths.test.mjs`
- Modify: `test/story-lettering-server.test.mjs`

**Interfaces:**
- Consumes: `.story-assets/cache/<chapter>/page-<page>-base.webp` 和 Git 中的 `page-<page>-lettering.json`。
- Produces: `.story-assets/exports/<chapter>/pages/page-<page>-final.{png,webp}`。

- [ ] **Step 1: 修改路径测试并确认 RED**

  断言 `baseWebp` 位于 cache，`layoutJson` 仍位于 Git，PNG/WebP 都位于 exports/pages；断言旧的 `docs/story/.../page-final.webp` 路径不再出现。

- [ ] **Step 2: 运行路径测试并确认 RED**

  Run: `node --test test/story-lettering-paths.test.mjs`
  Expected: FAIL because paths still point into `docs/story/chapters`.

- [ ] **Step 3: 修改路径实现并转绿**

  `resolvePagePaths()` 返回 `baseWebp`、`layoutJson`、`finalWebp`、`finalPng`，并对 cache、layout、exports 三个根目录分别进行越界检查。

- [ ] **Step 4: 修改服务器测试并确认 RED**

  fixture 将底图写入 cache；导出断言两个格式都写入 exports/pages；缺少底图时响应包含 `pnpm story:assets:pull -- --chapter <chapter> --page <page>`。

- [ ] **Step 5: 修改服务器实现并转绿**

  保持 API 路径和浏览器按钮行为不变，只修改文件事实来源与缺图错误文案。提供页面或底图前必须调用 `verifyLocalAsset()`；cache 过期或损坏时拒绝继续并给出单页 pull 命令。

- [ ] **Step 6: 完整回归**

  Run: `node --test test/story-lettering-paths.test.mjs test/story-lettering-server.test.mjs && pnpm test`
  Expected: all tests PASS.

---

### Task 4: 单页自动导出与整章打包

**Files:**
- Modify: `docs/story/tools/lettering/app.js`
- Create: `docs/story/tools/lettering/lib/chrome-export.mjs`
- Create: `docs/story/tools/lettering/lib/chapter-package.mjs`
- Create: `docs/story/tools/lettering/export-cli.mjs`
- Create: `test/story-chapter-package.test.mjs`
- Create: `test/story-export-cli.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 3 编辑器页面与输出目录。
- Produces: `window.__storyExportPage({ formats })`、`exportPageInChrome(...)`、`packageChapter(...)`。

- [ ] **Step 1: 写章节文件发现与打包失败测试**

  断言从 `page-*-lettering.json` 得到数值排序页码；缺任何 PNG/WebP 时列出缺页；Web HTML 使用相对的 `pages/page-XX-final.webp`；CBZ ZIP 条目有序；PDF 页数和布局 JSON 数量相同。

- [ ] **Step 2: 运行并确认 RED**

  Run: `node --test test/story-chapter-package.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `chapter-package.mjs`.

- [ ] **Step 3: 实现纯 Node 章节打包**

  使用 `fflate` 生成 CBZ，使用 `pdf-lib` 将每张 PNG 按原始宽高嵌入一页；Web 输出独立页面和连续滚动 `index.html`，不生成超长单张图。

- [ ] **Step 4: 暴露浏览器自动导出钩子并写 CLI 参数测试**

  `window.__storyExportPage({ formats: ["png", "webp"] })` 必须等待字体、保存布局、检查溢出并复用 `renderPageBlob()`；CLI 只接受二位页码与 `pages,web,pdf,cbz` 格式集合。

- [ ] **Step 5: 运行 CLI 测试并确认 RED**

  Run: `node --test test/story-export-cli.test.mjs`
  Expected: FAIL because CLI parser/export adapter does not exist.

- [ ] **Step 6: 实现 Chrome 适配器和导出 CLI**

  `playwright-core` 使用 `STORY_CHROME_PATH`，否则检测 macOS、Windows 和 Linux 常见 Chrome 路径。CLI 启动随机端口本地编辑器，逐页打开 URL 并执行浏览器钩子，最后按所选格式调用章节打包器。

- [ ] **Step 7: 添加依赖、脚本并验证真实页面**

  ```json
  {
    "story:export": "node docs/story/tools/lettering/export-cli.mjs"
  }
  ```

  Run: `pnpm install && pnpm story:export -- --chapter 01-agent-loop --page 01`
  Expected: `.story-assets/exports/01-agent-loop/pages/page-01-final.png` and `.webp` exist and pass `file` inspection.

- [ ] **Step 8: 导出整章并回归**

  Run: `pnpm story:export -- --chapter 01-agent-loop --formats web,pdf,cbz && pnpm test && pnpm typecheck`
  Expected: Web/PDF/CBZ all exist; all tests and typecheck PASS.

---

### Task 5: 清单迁移、Git 图片禁入与跨电脑指南

**Files:**
- Create: `docs/story/chapters/01-agent-loop/assets.json`
- Create: `docs/story/README.md`
- Modify: `docs/story/tools/lettering/README.md`
- Modify: `docs/story/design/manga-lettering-tool.md`
- Modify: `.gitignore`
- Test: `test/story-assets-policy.test.mjs`

**Interfaces:**
- Consumes: 前四项任务的最终命令和目录。
- Produces: 新用户唯一入口 `docs/story/README.md` 与 Git 二进制资源防线。

- [ ] **Step 1: 写 Git 策略失败测试**

  使用 `git check-ignore` 断言 `docs/story/` 下 PNG、JPG、JPEG、WebP、GIF、AVIF、TIFF、PSD、CLIP、KRA、PDF、CBZ、ZIP 被忽略；JSON、Markdown、JavaScript 不被忽略；`.story-assets/` 全部忽略。

- [ ] **Step 2: 运行并确认 RED**

  Run: `node --test test/story-assets-policy.test.mjs`
  Expected: FAIL because story image extensions are not ignored yet.

- [ ] **Step 3: 更新 `.gitignore` 并转绿**

  添加 `docs/story/**/*.<extension>` 的大小写无关模式或成对大小写模式，不添加缩略图白名单。

- [ ] **Step 4: 计算当前两页元数据并创建清单**

  清单 remote path 使用：

  ```text
  chapters/01-agent-loop/bases/page-01-base-v1.webp
  chapters/01-agent-loop/bases/page-02-base-v1.webp
  ```

  SHA-256、bytes、width、height 必须由 Task 1 代码读取，不手填猜测。

- [ ] **Step 5: 上传并回拉验证当前底图**

  上传到 `mo-code-story-assets` 对应目录；在空临时缓存中执行 pull；验证两个下载文件与清单一致。未完成此步时不得从 Git 索引移除图片。

- [ ] **Step 6: 编写顶层跨电脑指南**

  `docs/story/README.md` 必须包含：架构、依赖安装、`rclone config`、`STORY_RCLONE_REMOTE`、首次 pull、启动编辑器、换页、单页/整章导出、底图 v2 上传、命名规则、Git 禁入规则、故障恢复和命令速查。

- [ ] **Step 7: 精简工具 README 并修正文档事实**

  工具 README 只讲浏览器操作并链接顶层指南；设计文档不再声称底图或 final WebP 位于 Git。

- [ ] **Step 8: 安全退出已跟踪二进制文件**

  仅在 Step 5 通过后执行：

  ```bash
  git rm --cached docs/story/chapters/01-agent-loop/pages/page-01-base.webp
  git rm --cached docs/story/chapters/01-agent-loop/pages/page-01-final.webp
  ```

  page-02 当前未跟踪，因此只需移动/复制进 cache 并保持忽略。人物设定图必须先有对应清单与远端验证，未完成时暂不从索引移除。

- [ ] **Step 9: 最终验证**

  Run: `pnpm story:assets:verify -- --chapter 01-agent-loop && pnpm story:export -- --chapter 01-agent-loop --formats web,pdf,cbz && pnpm test && pnpm typecheck && git status --short`
  Expected: 资源验证、章节导出、测试和类型检查全通过；Git 状态不出现任何新图片、PDF、CBZ、ZIP 或 `.idea/` 变更。

## Self-Review

- Spec coverage: 清单、不可变版本、跨电脑授权、缓存、编辑器适配、单页导出、整章 Web/PDF/CBZ、`.gitignore`、迁移顺序和使用指南均有对应任务。
- Placeholder scan: 文档不含 TBD、TODO 或“类似前述”式占位步骤。
- Type consistency: `chapter` 使用 kebab-case，`page` 始终是二位字符串；缓存和导出路径在 Task 1–5 中保持一致。
