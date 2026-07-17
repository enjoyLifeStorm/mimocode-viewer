# MiMoCode Viewer

A lightweight web-based viewer for browsing MiMoCode sessions, tasks, and conversation history.

[English](#features) · [中文](#中文说明)

## Features

- **Directory-based tree navigation** — Sessions grouped by working directory for intuitive browsing
- **Markdown rendering** — Conversation messages rendered with proper formatting (code blocks, tables, lists, etc.)
- **Thinking toggle** — Show/hide AI reasoning content with a single click
- **Task tracking** — View task status (done/open/in-progress) within each session
- **Message search** — Full-text conversation history with role indicators (user/assistant)
- **Zero dependencies** — Runs on [Bun](https://bun.sh) with SQLite, no external services needed

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- MiMoCode installed and used at least once (creates the database)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/mimocode-viewer.git
cd mimocode-viewer

# Install dependencies (optional, Bun handles this automatically)
bun install

# Start the viewer
bun run start
```

Open [http://localhost:3456](http://localhost:3456) in your browser.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Server port |
| `MIMOCODE_DB` | `~/.local/share/mimocode/mimocode.db` | Path to MiMoCode database |

Example:

```bash
PORT=8080 bun run start
```

## Development

```bash
# Run with auto-reload
bun run dev
```

## How It Works

MiMoCode stores all session data in a local SQLite database (`mimocode.db`). This viewer reads that database in read-only mode and presents it through a clean web interface.

### Data Structure

```
Directory (working folder)
└── Session (conversation)
    ├── Messages (user/assistant exchanges)
    ├── Tasks (tracked work items)
    └── Thinking (AI reasoning, optional)
```

- **Directory** — The folder where `mimo` was launched
- **Session** — A single conversation thread
- **Task** — Work items created and tracked by the agent
- **Thinking** — AI reasoning content (collapsible)

## Tech Stack

- [Bun](https://bun.sh) — Runtime & SQLite
- [marked](https://github.com/markedjs/marked) — Markdown rendering (vendored)
- Vanilla HTML/CSS/JS — No framework dependencies

## License

MIT

---

## 中文说明

### 简介

MiMoCode Viewer 是一个轻量级的 Web 浏览器，用于查看 MiMoCode 的会话记录、任务跟踪和对话历史。

### 功能特性

- **目录树导航** — 按工作目录分组展示会话，清晰直观
- **Markdown 渲染** — 对话内容支持代码块、表格、列表等格式化显示
- **Thinking 开关** — 一键显示/隐藏 AI 推理过程
- **任务状态** — 查看每个会话中的任务进度（完成/进行中/未开始）
- **对话历史** — 完整的用户/AI 对话记录

### 快速开始

```bash
# 1. 确保已安装 Bun
curl -fsSL https://bun.sh/install | bash

# 2. 克隆项目
git clone https://github.com/YOUR_USERNAME/mimocode-viewer.git
cd mimocode-viewer

# 3. 启动
bun run start
```

浏览器访问 http://localhost:3456

### 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 服务端口 |
| `MIMOCODE_DB` | `~/.local/share/mimocode/mimocode.db` | MiMoCode 数据库路径 |

### 常见问题

**Q: 数据库文件在哪里？**

- macOS/Linux: `~/.local/share/mimocode/mimocode.db`
- Windows: `%LOCALAPPDATA%\mimocode\mimocode.db`

**Q: 可以同时查看多个项目吗？**

可以。所有项目目录下的会话都会按目录分组显示在左侧树形菜单中。

**Q: 支持只读模式吗？**

默认就是只读模式，不会修改任何数据。
