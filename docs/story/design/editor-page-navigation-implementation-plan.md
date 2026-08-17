# 漫画编辑器相邻页面导航实施计划

**目标：** 在漫画排字编辑器中加入只访问实际存在页面的“上一页/下一页”按钮，并在换页前可靠保存当前布局。

**架构：** 页面 GET API 在读取当前布局时扫描同章节 `pages/page-XX-lettering.json`，返回相邻页码；浏览器只消费这份导航元数据，不自行猜测页码。点击按钮时先调用现有 `saveLayout()`，成功后才更新查询参数并跳转。

**技术栈：** Node.js HTTP server、原生浏览器 JavaScript、HTML/CSS、`node:test`。

## 全局约束

- 只修改 story worktree，不提交或推送 Git。
- 不上传底图或导出图；导出图只保存在本机 `.story-assets/exports/`。
- 第一页禁用“上一页”，最后一页禁用“下一页”。
- 页面有缺号时跳到排序后的相邻实际页面。
- 保存失败时不离开当前页面。

### 任务 1：服务端返回实际相邻页面

**文件：**

- 修改：`test/story-lettering-server.test.mjs`
- 修改：`docs/story/tools/lettering/server.mjs`

- [x] 在测试夹具中写入 `page-03-lettering.json`，请求第 1 页时断言：

  ```js
  assert.deepEqual(value.navigation, { previous: null, next: "03" });
  ```

- [x] 先运行 `node --test test/story-lettering-server.test.mjs`，确认因缺少 `navigation` 而失败。
- [x] 新增页面文件发现函数：只接受 `page-(\d{2})-lettering.json`，按数字排序，定位当前页并返回前后页。
- [x] 在底图页和生成页的 GET 响应中统一加入 `navigation`。
- [x] 重跑服务端测试并确认通过。

### 任务 2：浏览器保存后换页

**文件：**

- 修改：`test/story-lettering-static.test.mjs`
- 修改：`docs/story/tools/lettering/index.html`
- 修改：`docs/story/tools/lettering/app.js`
- 修改：`docs/story/tools/lettering/styles.css`

- [x] 先加入静态失败测试，要求 HTML 包含 `previousPage`、`nextPage`，应用代码包含以下顺序：

  ```js
  await saveLayout();
  location.assign(targetUrl);
  ```

- [x] 运行 `node --test test/story-lettering-static.test.mjs`，确认按钮缺失导致失败。
- [x] 在当前页面摘要下加入两个按钮，并为禁用状态提供清晰样式。
- [x] 页面载入后依据 `navigation.previous/next` 设置按钮文本、禁用状态和目标页。
- [x] 点击时先禁用两个按钮并 `await saveLayout()`；成功后只替换 URL 的 `page` 参数，失败时恢复按钮并由现有保存状态显示错误。
- [x] 重跑静态测试并确认通过。

### 任务 3：更新工作流说明并整体验证

**文件：**

- 修改：`docs/story/README.md`
- 修改：`docs/story/tools/lettering/README.md`
- 修改：`docs/story/design/portable-story-assets.md`

- [x] 将导出图策略统一为“本地可重建产物，不上传 Drive”。
- [x] 将手改 URL 的换页说明替换为编辑器按钮；保留 URL 作为直接打开指定页的方法。
- [x] 运行：

  ```bash
  node --test test/story-lettering-server.test.mjs test/story-lettering-static.test.mjs
  pnpm test
  git diff --check
  ```

- [x] 在真实第 1、2、23 页验证：边界按钮、相邻跳转、保存成功后换页、没有页面载入错误。

### 任务 4：消除自动保存与换页保存的竞态

**文件：**

- 新增：`docs/story/tools/lettering/lib/save-queue.mjs`
- 新增：`test/story-lettering-save-queue.test.mjs`
- 修改：`docs/story/tools/lettering/app.js`
- 修改：`docs/story/tools/lettering/server.mjs`

- [x] 用延迟旧快照的测试证明新快照必须等待已有保存完成。
- [x] 验证旧保存失败后，新快照仍可继续写入。
- [x] 浏览器每次保存立即捕获当前 JSON 快照，并通过同一串行队列持久化。
- [x] 换页等待队列中的最新快照保存成功后才跳转。
