# 项目看板（Project Board）

**一句话定位**：一个 Cindy 插件，在一个页面里总览项目的任务状态、项目介绍、待办、AGENTS.md 等资料和 Git 状态。

## 项目目标

- 让用户不用翻侧边栏和文件，就能看清一个项目「现在在干什么、接下来要干什么」。
- 项目资料存放在项目自己的 `.cindy/` 目录里，随 git 提交，团队共享。
- 资料既能在看板里直接编辑，也能一键让 AI 生成或更新（在该项目里新建一个任务）。

## 主要功能

- **全部项目总览**：多个项目时默认打开总览，每个项目一张卡片（待处理与运行中的任务数、未完成待办数、分支与未提交改动、最近活动），等你处理的排在最前，点卡片进入该项目。
- **任务**：按状态分栏显示项目内的 Cindy 任务（待处理 / 运行中 / 刚完成 / 其他），已归档的折叠显示，点击可打开任务。订阅任务事件（只有元数据，不含内容），状态变化即时刷新。
- **待办**：读写 `.cindy/todos.md` 的勾选清单；支持勾选、改文字、删除、新增，可多选待办后一键新建任务交给 AI 完成。派出去的待办旁显示对应任务的状态，点击打开任务；对应关系只存在本机，不写进 `todos.md`。
- **项目介绍**：显示并可编辑 `.cindy/project.md`；保存前核对文件是否被别处改过，避免覆盖。
- **项目文件**：查看 README、AGENTS.md、CLAUDE.md、项目知识库（`.cindy/project-knowledge/TOC.md`），可让 AI 创建或维护；一键在 AGENTS.md 加入「项目资料」入口，并让 CLAUDE.md 通过 `@AGENTS.md` 导入。
- **Git**：当前分支、未提交改动数、最近 5 次提交、其他 worktree，并提示 `.cindy-worktrees/` 未被忽略的风险。
- 界面支持简体中文、繁体中文、英文、日文、韩文、西班牙文、法文、德文、葡萄牙文（巴西、葡萄牙），跟随 Cindy 语言；文言文界面回退到简体 / 繁体中文。插件名称与简介受宿主限制只有中、英、日、韩四种。
- 自动刷新：任务事件到达时立即刷新任务；兜底每 30 秒重读任务、每 60 秒重读全部资料。刷新时保留折叠区展开状态和滚动位置。

## 技术栈

- Cindy 插件（`ghost.json` schemaVersion 3，最低 Cindy 0.1.121）
- 原生 HTML / CSS / JavaScript，无框架、无构建步骤、无第三方依赖
- Node.js 工作进程（CommonJS，JSON-RPC over stdio，按需启动、空闲 120 秒退出），只用 Node 内置模块和本机 `git`
- 宿主能力：`cindy.targets`（项目列表、新建任务）、`cindy.observe`（只读任务列表）、`cindy.node`、`subscribe`（任务事件：turn / session / activity）

## 目录结构

```
project-board-plugin/
├── ghost.json          # 插件清单：入口、主视图、权限、Node 进程配置
├── main.js             # 电子脑：接收主视图请求，校验项目后转给宿主或 Node 进程
├── main-view.html      # 主视图页面骨架
├── main-view.js        # 主视图逻辑：渲染各卡片与项目总览、Markdown、自动刷新、发请求
├── main-view-i18n.js   # 主视图界面文案（10 种语言）
├── main-view.css       # 主视图样式（适配亮/暗色主题）
├── node/worker.cjs     # Node 工作进程：读资料、Git 状态与总览摘要，原子写入 .cindy/*.md、AGENTS.md、CLAUDE.md
├── locales/            # 插件名称、描述的多语言（en、zh-CN、ja、ko）
└── assets/icon.png     # 插件图标
```

数据流：主视图 ⇄（BroadcastChannel，按 reqId 去重重发）⇄ `main.js` → 宿主 API 或 `node/worker.cjs`。项目目录只接受 Cindy 已登记的项目，写操作在 Node 进程里串行执行。

## 如何运行和测试

- **运行**：在 Cindy 里用插件开发工具（`ghost_forge_pack` / `ghost_forge_install`）打包并安装 `project-board-plugin/`，然后在 Cindy 中打开「项目看板」主视图。打包产物 `*.cindy` 已被 git 忽略。
- **权限**：首次使用需在 Cindy 的插件详情页允许查看任务、新建任务。
- **测试**：目前没有自动化测试。可做语法检查：

  ```sh
  cd project-board-plugin
  node --check main.js && node --check main-view.js && node --check node/worker.cjs
  ```

  功能验证靠在 Cindy 里手动操作：切换项目、勾选/新增待办、编辑介绍、加入资料入口、让 AI 生成资料。
