# AtomCode GUI

> **A minimalist desktop client for the `atomcode` AI coding agent — 100% built by AI.**

---

## Overview

**AtomCode GUI** is an Electron-based desktop frontend for the [atomcode](https://crates.io/crates/atomcode) CLI tool. It wraps the agent's stdin/stdout stream into a clean, native chat interface with real-time streaming, tool-call visualization, and full Markdown rendering.

https://github.com/user-attachments/assets/bf9054b1-dca4-4962-871c-a2106cfddeeb

### Why?

The `atomcode` CLI produces rich output — thinking traces, tool invocations, streaming text — but consuming it in a raw terminal hides the structure. AtomCode GUI brings it to life:

- **Streaming responses** — see the AI reply word by word, no waiting
- **Tool call traces** — every file read, search, and command executed is visible inline
- **Thinking visible** — watch the AI reason step by step (verbose mode)
- **Markdown rendering** — code blocks, tables, lists, images all rendered natively

---

## Features

| Feature | Description |
|---------|-------------|
| ⚡ **Real-time streaming** | AI text arrives character-by-character; no flash-of-content |
| 🔧 **Tool call transparency** | See every `read_file`, `grep`, `bash` call and its result |
| 💬 **Conversation history** | Multi-turn chat, context accumulated over the session |
| 🌗 **Dark theme** | Modern dark UI, easy on the eyes |
| 📝 **Full Markdown** | Rendered via `markdown-it` — tables, code, lists, headings |
| ⚙️ **Settings panel** | Check atomcode status, set working directory |
| 🚀 **Lightweight** | Single window, no bundler, no framework — just Electron + vanilla JS |

---

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [atomcode](https://crates.io/crates/atomcode) CLI installed (daemon mode requires `atomcode-daemon`):
  ```bash
  cargo install atomcode
  ```
  Make sure `atomcode-daemon` (shipped with `atomcode`) is discoverable in your `PATH`.

---

## Quick Start

```bash
# Clone
git clone https://github.com/tev6/atomcode-gui.git
cd atomcode-gui

# Install dependencies
npm install

# Launch
npm start
```

The GUI will check for the `atomcode` binary automatically. If found, you can start chatting immediately.

---

## Project Structure

```
atomcode-gui/
├── main.js          # Electron main process (window, IPC, daemon process management, SSE)
├── preload.js       # Context bridge (exposes safe APIs to renderer)
├── renderer.js      # UI logic (streaming, events, DOM management)
├── index.html       # Layout & CSS variables (dark theme)
├── package.json
├── LICENSE
└── README.md
```

---

## Architecture

The app communicates with the `atomcode-daemon` via SSE (Server-Sent Events) over HTTP:

```
Renderer (renderer.js)
  │  IPC: atomcode:query
  ▼
Main Process (main.js)
  │  POST /chat (SSE)  ──► daemon (http://localhost:22728)
  │  GET  /sessions
  │  GET  /models
  │
  └── SSE stream events ──► IPC ──► Renderer
```

The daemon runs as a background process, exposing an HTTP API. The main process POSTs to `/chat` to start a streaming conversation; the daemon responds with SSE events (`thinking`, `tool→`, `tool←`, `message_chunk`, `done`). These are forwarded to the renderer via Electron IPC. Additional endpoints (`/sessions`, `/models`, `/providers`) power the settings panel. If the daemon is not running, the GUI starts it automatically.

---

## License

[MIT](LICENSE) © AtomGit

---

*This project was 100% developed by AI — from the first line of code to this README.*
