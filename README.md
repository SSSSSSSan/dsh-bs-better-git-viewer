# dsh-bs-better-git-viewer

DSH（DeepSeek Harness）Web 插件：**多仓库只读 Git 浏览器 + 交互终端**，作为 [dsh-better-sidebar] 的消费插件运行，为其侧边栏注册「Git 浏览」与「终端」两个标签页。

> ⚠️ **运行时依赖 [dsh-better-sidebar]**（声明为 peerDependency）：
> 本插件通过 `ctx.betterSidebar.registerTab` 注册标签页，终端复用其 `/sidebar/ws/terminal` pty 端点，**不包含自己的终端服务端**。
> 请先安装 dsh-better-sidebar，并在其设置中关闭内置 Git 标签页以避免重复。

## 功能特性

**多仓库 Git 浏览器（只读预览）**

- **多仓库自动发现**：向上查找当前工作区所属仓库 + 子目录广度优先扫描（深度有界，`node_modules` 与隐藏目录剪枝）
- **排除列表**：目录名可在设置面板编辑（每行一个，持久化在工作区根 `.dsh-bs-git-excludes`）
- **仓库选择记忆**：按会话 + 工作区记住上次选择的仓库，仓库消失自动回退默认
- **状态预览**：已暂存 / 未暂存分区（各自限高 240px、内部滚动，海量变更也不会撑爆面板）；中文文件名正常显示（`core.quotepath=false`，无 `\ooo` 八进制转义）
- **VSCode 式提交图**：分支泳道、节点、合并圆角连接线、分支流同色、`@` 标记当前分支/HEAD；分支/标签胶囊**纵向堆叠**，一个提交挂多个引用时完整显示（行高自适应，车道线保持连续）；基于 `git log --all --topo-order`，未合并分支与远端分支同样入图
- **文件级 diff**：单击提交 → 内联展开变更文件列表（限高 320px、拖拽调高、内部滚动）→ 单击文件查看该提交的单文件 diff；diff 行级 +绿/−红底色、拖拽调高、长行自动换行、sticky 文件头、新增/删除/重命名/二进制徽标
- **自动刷新**：插件自有 WebSocket（`/bsgit/ws/changes`）+ host 侧 `fs.watch` 监视 `.git` 元数据（提交 / 暂存 / 检出 / 分支变化），250ms 防抖推送——完全绕开 DSH 会话事件管道
- **纯预览定位**：提交 / 暂存 / 丢弃等写操作刻意交给智能体在会话中执行（host 保留写路由，UI 不提供）

**交互终端（san-terminal）**

- xterm.js 交互终端：光标闪烁、长行自动换行、右键复制选中（Windows 终端风格）
- 连接 dsh-better-sidebar 的 pty 端点：断线自动重连、服务端拒绝显示原因并提供手动重试
- 每会话最多 3 个终端标签页

## 依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| [dsh-better-sidebar] | ^0.12.x（peerDependency；可选声明，运行时必需） | 标签页注册 + 终端 pty 端点 |
| DSH（DeepSeek Harness） | Web 平台 | 宿主 |
| React | ^18.2 | |
| 系统 `git` 二进制 | 任意现代版本 | host 半经 `spawn` 调用，不依赖任何 git 库 |

## 安装

```bash
pnpm install
pnpm build      # tsdown → out/index.js（host 半）+ out/client.js（client 半）
pnpm typecheck
pnpm test
```

按 DSH 插件机制把本目录挂载为插件（如 `dsh plugin --profile <profile> add <本目录>`，详见 [dsh-better-sidebar] 的插件接入文档与 DSH 官方文档），并确保 dsh-better-sidebar 已安装、其内置 Git 标签页已关闭。

也可以直接运行仓库自带的安装脚本（构建 + 官方 CLI 安装 + 层验证）：

```bash
node scripts/install.mjs                 # 默认 profile=web，走 npx 拉取官方 CLI
node scripts/install.mjs --profile demo  # 指定 profile
node scripts/install.mjs --dsh-dir <路径> # 本地 DSH 源码构建模式（pnpm dsh，从指定目录执行）
```

**安装脚本（`scripts/install.mjs`）设计说明**：

- **只依赖官方 DSH CLI**：脚本不做任何手工操作，唯一入口是 `dsh plugin --profile <name> add <本目录>`，与手动安装完全等价；流程为「构建（`--skip-build` 可跳过）→ 安装 → 用 `--dump-config` 验证 `# == dsh-bs-better-git-viewer` 层出现」。
- **两种 CLI 获取方式**：
  - **默认（npx）**：按需拉取 `@deepseek-ai/dsh` 执行，**不需要本地 DSH checkout、不需要全局安装**，任何机器可用，适合普通用户。
  - **本地源码构建（`--dsh-dir <路径>` 或环境变量 `DSH_REPO_DIR`）**：从指定目录执行 `pnpm dsh ...`，适合 dsh 采用「拉取源码自行构建运行」的开发者；**路径只在运行时传入，不写入仓库**。
- 脚本不包含任何机器相关的硬编码路径，可安全提交到公开仓库。

## 使用

- 侧边栏「+」菜单 → **Git**：切换仓库、浏览状态、展开提交、查看文件级 diff
- 侧边栏「+」菜单 → **终端**：交互 shell
- 设置面板（侧边卡片 → Git 齿轮）：编辑排除列表

## 架构

```
src/index.ts          host 半：/bsgit/api 路由（repos.list / excludes / git.status|branch|log|showFiles|showFile|diff）
                      + 自有 WebSocket /bsgit/ws/changes（git 变更推送）
src/git.ts            git 命令封装：spawn 系统 git、porcelain -z 解析、core.quotepath=false、仓库发现
src/trust-fence.ts    浏览器信任围栏（与 DSH /api 网关同模型）
src/git-watch.ts      fs.watch 监视 .git 元数据 → WebSocket 推送
src/client/index.tsx  经 ctx.betterSidebar.registerTab 注册 bs-git-viewer + san-terminal
src/client/GitView.tsx   面板 UI：仓库下拉、状态预览、提交图、内联 diff、懒加载历史
src/client/graph.ts   提交图泳道布局（纯函数，独立单测）
src/client/DiffBlock.tsx  彩色可调高 diff 视图（unified diff 解析渲染）
src/client/TerminalView.tsx  终端（xterm + WS 到 better-sidebar pty 端点）
```

- **数据层自持**：`/bsgit/api` 走系统 `git` 二进制 + 信任围栏，不依赖 dsh-better-sidebar 的 git 路由（仅依赖其标签页注册与终端端点）
- **自动刷新绕开会话事件管道**：变更通知经插件自有 WebSocket，不触碰 DSH 的会话事件流

## 许可

MIT

[dsh-better-sidebar]: https://github.com/omdsh-dev/DSH-better-sidebar
