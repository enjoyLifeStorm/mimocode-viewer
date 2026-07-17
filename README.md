# MiMoCode Viewer

A lightweight web-based viewer for browsing MiMoCode sessions, tasks, and conversation history.

[English](README.md) · [中文](README.zh-CN.md)

## Features

- **Directory-based tree navigation** — Sessions grouped by working directory for intuitive browsing
- **Markdown rendering** — Conversation messages rendered with proper formatting (code blocks, tables, lists, etc.)
- **Thinking toggle** — Show/hide AI reasoning content with a single click
- **Task tracking** — View task status (done/open/in-progress) within each session
- **Message search** — Full-text conversation history with role indicators (user/assistant)
- **Zero dependencies** — Runs on [Bun](https://bun.sh) with SQLite, no external services needed

## Installation

### Option 1: Pre-built Binary (Recommended)

Download the latest release for your platform from [Releases](https://github.com/enjoyLifeStorm/mimocode-viewer/releases):

| Platform | File |
|---|---|
| Windows (x64) | `mimocode-viewer-win-x64.zip` |
| macOS (Intel) | `mimocode-viewer-darwin-x64.tar.gz` |
| macOS (Apple Silicon) | `mimocode-viewer-darwin-arm64.tar.gz` |
| Linux (x64) | `mimocode-viewer-linux-x64.tar.gz` |
| Linux (ARM64) | `mimocode-viewer-linux-arm64.tar.gz` |

```bash
# Example: macOS Apple Silicon
tar -xzf mimocode-viewer-darwin-arm64.tar.gz
./mimocode-viewer

# Example: Windows
# Extract the zip and run mimocode-viewer.exe
```

### Option 2: From Source

Requires [Bun](https://bun.sh) v1.0+.

```bash
git clone https://github.com/enjoyLifeStorm/mimocode-viewer.git
cd mimocode-viewer
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
