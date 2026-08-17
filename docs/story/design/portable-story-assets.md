# 漫画资源跨设备维护与导出设计

## 背景

mo-code 漫画预计包含约 13 个章节，每章 10–20 页。无字底图、人物设定图和最终成品均为二进制图片；即使每张图片仅约 200–350 KB，同时保存底图、成品和历史版本，也会使 Git 仓库快速增长。二进制图片的每次修改通常都会在 Git 历史中产生一个新的完整对象。

本设计将 Git 作为故事与排字事实来源，将 Google Drive 作为不可变二进制资源远端，并将本地图片视为可删除缓存。目标是在新电脑上完成一次授权后，可以从同一 Git 提交恢复底图、编辑漫画并生成相同的单页或章节输出。

## 决策

采用“Git 资源清单 + rclone Google Drive 适配器 + 本地缓存”的混合方案。

- Git 保存：`script.md`、`assets.json`、`page-*-lettering.json`、渲染器、测试和使用指南。
- Google Drive 保存：原始 PNG、WebP 底图和人物设定图等无法由 Git 文本重建的素材；不保存页面成品或章节成品。
- `.story-assets/` 保存本机缓存与导出结果，并始终被 Git 忽略。
- `script.md` 不保存云盘链接；所有机器可读的资源信息进入章节级 `assets.json`。
- 云盘资源采用不可变版本名，如 `page-02-base-v1.webp`。修改底图时上传 `v2`，不覆盖 `v1`。
- 每个清单条目保存 SHA-256、字节数和像素尺寸。下载后必须验证，失败时不得继续渲染。

## 目录结构

```text
docs/story/
├── README.md
├── chapters/
│   └── 01-agent-loop/
│       ├── script.md
│       ├── assets.json
│       └── pages/
│           ├── page-01-lettering.json
│           └── page-02-lettering.json
├── design/
└── tools/

.story-assets/
├── cache/
│   └── 01-agent-loop/
│       ├── page-01-base.webp
│       └── page-02-base.webp
└── exports/
    └── 01-agent-loop/
        ├── pages/
        ├── web/
        ├── chapter-01-agent-loop.pdf
        └── chapter-01-agent-loop.cbz
```

Google Drive 根目录使用相同的章节键：

```text
mo-code-story-assets/
└── chapters/
    └── 01-agent-loop/
        ├── sources/
        └── bases/
```

## 资源清单

`docs/story/chapters/<chapter>/assets.json` 是资源定位事实来源：

```json
{
  "version": 1,
  "chapter": "01-agent-loop",
  "pages": {
    "01": {
      "base": {
        "remotePath": "chapters/01-agent-loop/bases/page-01-base-v1.webp",
        "cacheFile": "page-01-base.webp",
        "sha256": "<64 lowercase hex characters>",
        "bytes": 319422,
        "width": 864,
        "height": 1821
      }
    }
  }
}
```

清单不保存机器相关的 rclone remote 名称。每台机器通过环境变量配置：

```text
STORY_RCLONE_REMOTE=mo-code-story:
```

remote 必须指向 `mo-code-story-assets` 文件夹根目录。OAuth token、服务账号 JSON 和 rclone 配置不得进入 Git。

## 模块与接口

### 资源清单模块

负责读取、验证和原子更新 `assets.json`，并计算缓存路径。调用者只使用章节名和页码，不接触 Drive 文件 ID。

```js
loadAssetManifest({ projectRoot, chapter })
resolvePageAsset({ manifest, chapter, page, kind: "base" })
verifyLocalAsset({ filePath, asset })
```

### 远端同步模块

同步模块的接口只包含 `pull`、`push` 和 `verify`。rclone 是第一个远端适配器；以后改用 S3、R2 或 OSS 时，编辑器不变。

```js
pullPageBase({ projectRoot, chapter, page, remote, runRemoteCommand })
pushPageBase({ projectRoot, chapter, page, version, sourceFile, remote, runRemoteCommand })
```

`pull` 下载到临时文件，验证哈希、尺寸和字节数后原子移动到 `.story-assets/cache/`。`push` 先计算元数据，以不可变版本名上传，并通过 rclone `--immutable --checksum` 拒绝不同内容覆盖同名远端对象；成功后才原子更新 Git 中的清单。

### 编辑器适配

`page-*-lettering.json` 继续保存 `source.width`、`source.height` 和逻辑文件名，但服务器从 `.story-assets/cache/<chapter>/` 读取底图。

启动编辑器前执行资源拉取；网页服务器在提供底图前还会按清单复验 SHA-256、字节数、尺寸和 PNG/WebP 格式。缺少或过期缓存时显示准确命令，不在网页服务器中保存云盘凭据：

```bash
pnpm story:assets:pull -- --chapter 01-agent-loop
pnpm story:lettering
```

### 导出模块

单页与章节导出必须复用浏览器中的 `drawLettering()`，避免出现预览与导出排版差异。自动化命令使用本机 Chrome 的无头模式访问本地编辑器；Chrome 路径可由 `STORY_CHROME_PATH` 覆盖。

```bash
pnpm story:export -- --chapter 01-agent-loop --page 02
pnpm story:export -- --chapter 01-agent-loop --formats web,pdf,cbz
```

单页导出产生 PNG 和 WebP。章节导出先保证每页成品最新，再生成：

- `pages/`：独立页面 PNG/WebP；
- `web/index.html`：连续滚动阅读，页面仍按需加载独立 WebP；
- `chapter-<chapter>.pdf`：一张漫画页对应一页 PDF；
- `chapter-<chapter>.cbz`：按页码排序的 WebP ZIP 包。

不生成整章单张 WebP。每页约 1820 px 高，10 页已经超过 WebP 单边 16383 px 的格式限制。

## Git 图片策略

`.gitignore` 默认拒绝 `docs/story/` 下的新二进制图片与漫画包，包括 PNG、JPG、JPEG、WebP、GIF、AVIF、TIFF、PSD、CLIP、KRA、PDF、CBZ 和 ZIP。

已有已跟踪图片不会因为新增忽略规则自动退出 Git。迁移时必须：

1. 上传并验证远端版本；
2. 创建并提交 `assets.json`；
3. 确认新电脑可以拉取；
4. 使用 `git rm --cached` 移除 Git 索引中的二进制文件；
5. 保留本机缓存，不删除用户原始文件。

如果未来确实需要 Git 中的小缩略图，必须放入单独白名单目录 `docs/story/thumbnails/`，并明确限制尺寸；首版不建立该白名单。

## 跨设备与 CI

新电脑首次设置：

1. 安装 Node.js、pnpm、Chrome 和 rclone；
2. 克隆 Git 仓库；
3. 执行 `rclone config`，创建指向共享 Drive 文件夹的 remote；
4. 设置 `STORY_RCLONE_REMOTE`；
5. 执行资源拉取和测试；
6. 启动编辑器或运行导出。

CI 使用只读或读写服务账号，凭据通过 CI Secret 注入；仓库只保存变量名与示例配置。

## 错误处理

- remote 未配置：给出 `rclone config` 和环境变量提示；
- remote 不是安全的 `<name>:` 根名称：在调用 rclone 前拒绝，避免把远端路径误当成本地路径或选项；
- 资源不在清单：报告章节、页码和缺少的种类；
- 下载失败：保留旧缓存和临时文件诊断信息；
- 哈希或尺寸不一致：删除临时文件并拒绝替换缓存；
- 编辑器发现 cache 与清单不一致：拒绝预览和导出，并给出单页 pull 命令；
- 布局保存失败：手动与自动导出都必须中止，不得生成无法由 Git 布局重建的成品；
- 上传成功但清单写入失败：报告远端路径，不覆盖旧清单；
- 页面导出缺失：章节打包失败并列出缺页；
- Chrome 不可用：给出 `STORY_CHROME_PATH` 设置方式；
- 章节打包失败：保留已成功生成的单页成品。

## 使用指南

`docs/story/README.md` 是其他电脑和其他使用者的唯一入口，必须覆盖：

- 系统结构与事实来源；
- 新电脑安装、Drive 授权和环境变量；
- 下载、编辑、单页导出、章节导出和上传流程；
- 文件命名、版本管理和 Git 图片禁入规则；
- 常见错误与恢复方法；
- 当前章节与页面示例。

`docs/story/tools/lettering/README.md` 只保留网页编辑器操作细节，并链接回顶层指南。

## 验收标准

- 新电脑在一次授权后可以从 Git + Drive 恢复已登记底图；
- 下载后校验 SHA-256、尺寸和字节数；
- 编辑器不依赖 `docs/story/` 中的图片文件；
- 单页命令输出 PNG 与 WebP；
- 章节命令输出独立页面、Web、PDF 和 CBZ；
- 所有输出位于 `.story-assets/`，不进入 Git；
- `.gitignore` 阻止预期之外的故事图片与漫画包；
- 顶层使用指南可由未参与开发的人从零完成设置和导出；
- 当前两页内容在迁移后仍可编辑和导出；
- 自动化测试和类型检查通过。
