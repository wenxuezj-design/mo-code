# 漫画跨电脑工作流

这是漫画素材同步、排字与导出的唯一入口。所有命令都从仓库根目录运行；网页编辑器的具体操作见[排字工具说明](tools/lettering/README.md)。

## 数据放在哪里

漫画工作流把可审查的文本事实与二进制文件分开：

- Git 保存 `script.md`、章节 `assets.json`、`page-*-lettering.json`、工具代码、测试和文档。
- Google Drive 的 `mo-code-story-assets` 保存不可变版本的底图与其他需要共享的二进制素材。
- `.story-assets/cache/<chapter>/` 是可删除、可重新拉取的本机底图缓存。
- `.story-assets/exports/<chapter>/` 是可删除、可重新生成的 PNG、WebP、网页、PDF 和 CBZ。

章节清单 `docs/story/chapters/<chapter>/assets.json` 是底图远端路径、SHA-256、字节数和像素尺寸的事实来源。排字编辑器从本机 cache 读取底图；页面成品不进入清单，而是从底图与 Git 中的布局 JSON 重建。

```text
Git: assets.json + lettering.json
          │
          ├── pull + verify ── Drive: chapters/<chapter>/bases/*-vN.webp
          │                         │
          ▼                         ▼
 .story-assets/cache/ ── editor/export ──> .story-assets/exports/
```

## 新电脑首次设置

### 1. 安装依赖

安装 [Node.js 24](https://nodejs.org/en/download)、[Google Chrome](https://www.google.com/chrome/) 和 [rclone](https://rclone.org/install/)。本项目使用 pnpm 10：

```bash
npm install --global pnpm@10
```

macOS 可以用 Homebrew 安装 rclone 和 Chrome：

```bash
brew install rclone
brew install --cask google-chrome
```

检查命令是否可用：

```bash
node --version
pnpm --version
rclone version
```

Chrome 装在系统常见位置时会被自动发现。非标准安装位置稍后用 `STORY_CHROME_PATH` 指定。

### 2. 安装仓库依赖

克隆团队仓库后进入仓库根目录，然后运行：

```bash
pnpm install --frozen-lockfile
```

### 3. 配置 Google Drive remote

运行交互式配置：

```bash
rclone config
```

创建一个名为 `mo-code-story` 的新 remote，存储类型选择 Google Drive，并在浏览器中用有权访问共享素材的账号授权。remote 的根必须是 Drive 中的 `mo-code-story-assets` 文件夹，而不是整个个人云盘：在高级配置中把 `root_folder_id` 设为该文件夹 URL 里的文件夹 ID。OAuth token 和 rclone 配置只保存在本机，绝不能提交到 Git。

验证 remote 根；第一条应能看到 `chapters/`，第二条应能看到当前底图版本：

```bash
rclone lsf mo-code-story:
rclone lsf mo-code-story:chapters/01-agent-loop/bases/
```

为当前 shell 设置工具使用的 remote。值必须是安全的 rclone remote 名加一个结尾冒号（例如 `mo-code-story:`），不能省略冒号，也不能追加子目录或 rclone 选项；这个 remote 本身已经通过 `root_folder_id` 指向素材根：

```bash
export STORY_RCLONE_REMOTE='mo-code-story:'
```

可以把同一行加入本机 shell 配置，例如 `~/.zshrc`。PowerShell 当前会话使用：

```powershell
$env:STORY_RCLONE_REMOTE = 'mo-code-story:'
```

### 4. 拉取并验证底图

首次使用某章时，先拉取清单中登记的全部页面，再独立校验本机缓存：

```bash
pnpm story:assets:pull -- --chapter 01-agent-loop
pnpm story:assets:verify -- --chapter 01-agent-loop
```

只处理一页时加入二位页码：

```bash
pnpm story:assets:pull -- --chapter 01-agent-loop --page 02
pnpm story:assets:verify -- --chapter 01-agent-loop --page 02
```

`pull` 先下载到临时文件，校验 SHA-256、bytes、width 和 height 后才替换 cache。校验失败时不要绕过清单或强行使用文件。

## 编辑排字与换页

确认底图已经拉取后启动本地编辑器：

```bash
pnpm story:lettering
```

默认打开第 1 章第 1 页：

```text
http://127.0.0.1:41731/?chapter=01-agent-loop&page=01
```

编辑器左侧提供“上一页”和“下一页”，会在保存当前布局后切换到相邻的实际页面；第一页和最后一页对应按钮自动禁用。也可以通过 URL 直接打开指定页面，例如第 2 页：

```text
http://127.0.0.1:41731/?chapter=01-agent-loop&page=02
```

章节名必须是小写 kebab-case，页码必须恰好两位，所有页面都必须存在对应的 `page-<page>-lettering.json`。使用漫画底图的页面还需要 `assets.json` 清单条目和已验证 cache；`source.kind="generated"` 的附录页由布局直接绘制，不需要底图清单。编辑约 400 ms 后自动保存到布局 JSON；关闭浏览器前确认右上角显示“已保存”。

## 导出

### 单页 PNG 与 WebP

下面的命令会临时启动编辑器，用本机 Chrome 渲染第 1 页，并在导出前保存布局和拒绝文字溢出。布局保存失败时，无论网页按钮还是自动命令都会中止导出：

```bash
pnpm story:export -- --chapter 01-agent-loop --page 01
```

真实输出是：

```text
.story-assets/exports/01-agent-loop/pages/page-01-final.png
.story-assets/exports/01-agent-loop/pages/page-01-final.webp
```

### 整章 Web、PDF 与 CBZ

下面的命令发现该章所有 `page-*-lettering.json`，先逐页重新生成 PNG/WebP，再打包整章：

```bash
pnpm story:export -- --chapter 01-agent-loop --formats web,pdf,cbz
```

输出目录和文件名固定为：

```text
.story-assets/exports/01-agent-loop/
├── pages/page-01-final.{png,webp}
├── web/index.html
├── web/page-01.html
├── web/pages/page-01-final.webp
├── chapter-01-agent-loop.pdf
└── chapter-01-agent-loop.cbz
```

`--formats` 可以选择 `web`、`pdf`、`cbz` 的任意非重复组合。`--page` 只用于单页 `pages` 导出，不能与章节打包格式组合。

final 与章节包都是可重建成品，不属于 `assets.json`，不进入 Git，也不上传 Google Drive。修改脚本或排字 JSON 后直接重新导出；同名本地成品会被最新结果替换。Drive 只保存无法由 Git 文本重建的底图、原稿和人物素材。

## 上传新的底图版本

生成候选底图本身不会触发上传。即使同一页生成了多版，也只在用户确认最终底图后执行一次 push；未采用的中间图留在本机并可直接删除。只有已经采用的底图后来确实发生替换时，才递增远端版本号。

Drive 中的底图名称不可变。修改现有 v1 时必须选择尚未使用的 v2，不能覆盖或复用旧版本号。上传命令会用 rclone 的 immutable + checksum 校验拒绝用不同内容覆盖同名远端文件。先查看远端已有版本：

```bash
rclone lsf "${STORY_RCLONE_REMOTE}chapters/01-agent-loop/bases/"
```

把待上传的 PNG 或 WebP 放在 `.story-assets/` 下，并通过绝对路径执行 push。例如：

```bash
pnpm story:assets:push -- \
  --chapter 01-agent-loop \
  --page 01 \
  --version v2 \
  --source "$PWD/.story-assets/incoming/page-01-base-v2.webp"
```

push 成功后才会原子更新该章 `assets.json`。随后从新清单回拉并验证；旧 cache 与新清单不一致时会被已验证的下载替换：

```bash
pnpm story:assets:pull -- --chapter 01-agent-loop --page 01
pnpm story:assets:verify -- --chapter 01-agent-loop --page 01
git diff -- docs/story/chapters/01-agent-loop/assets.json
```

如果 v2 改变了扩展名或像素尺寸，还必须显式更新同页布局 JSON 的 `source.file`、`source.width` 和 `source.height`，重新排字并导出；编辑器不会静默缩放旧布局。上传或回拉验证失败时，不要提交新清单。

## 命名规则

- 章节：`01-agent-loop`，只允许小写字母、数字和单个连字符分段。
- 页码：`01`、`02`，始终是两位数字。
- Git 布局：`page-<page>-lettering.json`。
- 本机底图 cache：`page-<page>-base.<ext>`。
- Drive 底图：`page-<page>-base-v<positive-integer>.<ext>`，如 `page-01-base-v2.webp`。
- 单页成品：`page-<page>-final.png` 和 `page-<page>-final.webp`。
- 章节包：`chapter-<chapter>.pdf` 和 `chapter-<chapter>.cbz`；网页入口固定为 `web/index.html`。

## Git 二进制策略

`.gitignore` 拒绝 `docs/story/` 下大小写任意的 PNG、JPG、JPEG、WebP、GIF、AVIF、TIF、TIFF、PSD、CLIP、KRA、PDF、CBZ 和 ZIP；Markdown、JSON、JavaScript 继续进入 Git。`.story-assets/` 整体忽略。

不要使用 `git add -f` 绕过策略，也不要创建临时缩略图白名单。提交前检查：

```bash
git status --short
git check-ignore -v --no-index docs/story/path/to/candidate.webp
```

已有已跟踪图片不会因 `.gitignore` 自动退出索引。只有在对应素材已经上传、建立清单并完成回拉校验后，才能用 `git rm --cached <path>` 安全退出索引；不要使用会删除工作区原件的 `git rm <path>`。

当前四张人物设定 WebP 是初始版本中明确保留的轻量参考图（每张约 160–213 KB），对应的高分辨率 PNG 原稿已经备份到 Drive。它们供人物文档在新电脑上直接显示，不属于漫画底图或导出成品。除这四个既有路径外，新人物图片仍不得加入 Git；新增或替换图片应先设计远端清单与同步方式，不要使用 `git add -f` 扩大例外范围。

## 字体限制

工具不内嵌字体。布局 JSON 只记录字体名，Chrome 会使用当前系统实际安装的字体；`PingFang SC` 和 `SFMono-Regular` 主要来自 macOS。缺少字体时浏览器会回退到本机 sans-serif/monospace，可能改变换行、字宽和最终像素，因此跨操作系统不保证导出文件逐字节一致。

正式导出应使用安装了相同字体的机器，并在编辑器中重新检查所有文字区域。自动导出会等待 `document.fonts.ready`，但这只能等待可用字体加载完成，不能证明指定字体确实安装。

## 常见故障

- `STORY_RCLONE_REMOTE is missing`：重新执行 `export STORY_RCLONE_REMOTE='mo-code-story:'`。
- `STORY_RCLONE_REMOTE must be a remote name...`：变量只能是类似 `mo-code-story:` 的 remote 根名称；检查结尾冒号，并移除子目录、空格或选项。
- `rclone is not installed`：按上面的安装步骤安装并确认 `rclone version`。
- Drive 授权过期：运行 `rclone config reconnect mo-code-story:`，再用 `rclone lsf mo-code-story:` 验证。
- remote 根错误或文件找不到：`rclone lsf mo-code-story:` 必须直接显示 `chapters/`；否则重新配置 `root_folder_id`。
- SHA、bytes 或尺寸不匹配：远端对象与 `assets.json` 不一致。保留旧 cache，检查 `remotePath` 和版本号；不要手改哈希来迁就错误文件。
- `BASE_ASSET_STALE`：编辑器发现 cache 与 `assets.json` 的 SHA、bytes、尺寸或图像格式不一致；执行错误中给出的单页 pull 命令后刷新。
- 编辑器提示底图未缓存：执行提示中的单页 `story:assets:pull` 命令，再刷新页面。
- `LAYOUT_ASSET_MISMATCH`：布局的 `source.file/width/height` 与当前清单不一致；确认底图版本后显式迁移布局。
- Chrome 未找到：设置可执行文件绝对路径，例如 macOS：

  ```bash
  export STORY_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ```

- 导出提示文字溢出：在网页中扩大区域或使用“自动适配”，等待显示“已保存”后重试。
- 章节导出缺页：先确认对应的 `page-*-lettering.json` 存在；底图页还要有清单条目和已验证 cache，`source.kind="generated"` 的附录页不需要。整章命令会重建所有发现的页面。
- 导出中断：布局 JSON 与已完成的页面输出会保留；修复错误后重复同一命令即可覆盖可重建成品。

本工具绑定 `127.0.0.1`，面向用户本人控制的可信本地仓库；安全路径校验用于阻止 URL/参数路径穿越，不把仓库当成可执行不可信内容的沙箱。不要在来源不可信、含可疑符号链接的 checkout 中启动编辑器。

## 命令速查

```bash
# 安装项目依赖
pnpm install --frozen-lockfile

# 拉取/验证整章或单页底图
pnpm story:assets:pull -- --chapter 01-agent-loop
pnpm story:assets:verify -- --chapter 01-agent-loop
pnpm story:assets:pull -- --chapter 01-agent-loop --page 02
pnpm story:assets:verify -- --chapter 01-agent-loop --page 02

# 启动网页编辑器
pnpm story:lettering

# 单页与整章导出
pnpm story:export -- --chapter 01-agent-loop --page 01
pnpm story:export -- --chapter 01-agent-loop --formats web,pdf,cbz

# 上传不可变底图 v2（source 必须是绝对路径）
pnpm story:assets:push -- --chapter 01-agent-loop --page 01 --version v2 --source "$PWD/.story-assets/incoming/page-01-base-v2.webp"

# 工程验证
node --test test/story-assets-policy.test.mjs
pnpm test
pnpm typecheck
git status --short
```
