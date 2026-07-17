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

- MiMoCode 已安装并至少使用过一次

## 安装方式

### 方式一：下载预编译版本（推荐）

从 [Releases](https://github.com/enjoyLifeStorm/mimocode-viewer/releases) 下载对应平台的文件：

| 平台 | 文件 |
|---|---|
| Windows (x64) | `mimocode-viewer-win-x64.zip` |
| macOS (Intel) | `mimocode-viewer-darwin-x64.tar.gz` |
| macOS (Apple Silicon) | `mimocode-viewer-darwin-arm64.tar.gz` |
| Linux (x64) | `mimocode-viewer-linux-x64.tar.gz` |
| Linux (ARM64) | `mimocode-viewer-linux-arm64.tar.gz` |

```bash
# 示例：macOS Apple Silicon
tar -xzf mimocode-viewer-darwin-arm64.tar.gz
./mimocode-viewer

# 示例：Windows
# 解压 zip 文件后运行 mimocode-viewer.exe
```

### 方式二：从源码构建

需要 [Bun](https://bun.sh) v1.0+。

```bash
git clone https://github.com/enjoyLifeStorm/mimocode-viewer.git
cd mimocode-viewer
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
