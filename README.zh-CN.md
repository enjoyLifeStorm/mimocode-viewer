# MiMoCode Viewer

MiMoCode 会话查看器 — 一个轻量级的 Web 界面，用于浏览 MiMoCode 的会话记录、任务和对话历史。

[English](README.md) | 中文

## 功能特性

- **目录树导航** — 按工作目录分组展示会话，清晰直观
- **Markdown 渲染** — 对话内容支持代码块、表格、列表等格式化显示
- **Thinking 开关** — 一键显示/隐藏 AI 推理过程
- **任务状态** — 查看每个会话中的任务进度
- **零依赖** — 基于 Bun + SQLite，无需外部服务

## 环境要求

- [Bun](https://bun.sh) 运行时 (v1.0+)
- MiMoCode 已安装并至少使用过一次

## 快速开始

```bash
# 克隆项目
git clone https://github.com/YOUR_USERNAME/mimocode-viewer.git
cd mimocode-viewer

# 启动
bun run start
```

浏览器访问 http://localhost:3456

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 服务端口 |
| `MIMOCODE_DB` | `~/.local/share/mimocode/mimocode.db` | MiMoCode 数据库路径 |

示例：

```bash
PORT=8080 bun run start
```

## 开发

```bash
bun run dev
```

## 数据库位置

| 系统 | 路径 |
|---|---|
| macOS/Linux | `~/.local/share/mimocode/mimocode.db` |
| Windows | `%LOCALAPPDATA%\mimocode\mimocode.db` |

## 技术栈

- [Bun](https://bun.sh) — 运行时 & SQLite
- [marked](https://github.com/markedjs/marked) — Markdown 渲染
- 原生 HTML/CSS/JS — 无框架依赖

## License

MIT
