# AtomCode GUI

> **atomcode AI 编码助手的极简桌面客户端 —— 100% 由 AI 构建。**

---

## 概述

**AtomCode GUI** 是一个基于 Electron 的桌面前端，为 [atomcode](https://crates.io/crates/atomcode) CLI 工具提供原生聊天界面。它将 agent 的 stdin/stdout 流包装成干净的对话式 UI，支持实时流式输出、工具调用可视化和完整的 Markdown 渲染。

### 为什么？

`atomcode` CLI 的输出很丰富 —— 思考过程、工具调用轨迹、流式文本 —— 但在纯终端中消费会丢失所有结构信息。AtomCode GUI 让这些信息变得清晰可见：

- **流式回复** —— 逐字看到 AI 的回答，无需等待
- **工具调用透明** —— 每次文件读取、搜索和命令执行都在聊天中可见
- **思考过程** —— 观察 AI 一步步推理（verbose 模式）
- **Markdown 渲染** —— 代码块、表格、列表、标题等原生渲染

---

## 功能

| 功能 | 说明 |
|------|------|
| ⚡ **实时流式** | AI 文本逐字符到达，无内容闪烁 |
| 🔧 **工具调用透明** | 查看每次 `read_file`、`grep`、`bash` 调用及其结果 |
| 💬 **对话历史** | 多轮对话，上下文在会话中持续累积 |
| 🌗 **暗色主题** | 现代化暗色 UI，护眼 |
| 📝 **完整 Markdown** | 通过 `markdown-it` 渲染 —— 表格、代码、列表、标题 |
| ⚙️ **设置面板** | 检查 atomcode 状态，设置工作目录 |
| 🚀 **轻量级** | 单窗口，无打包器，无框架 —— 只有 Electron + 原生 JS |

---

## 前置条件

- [Node.js](https://nodejs.org/) >= 18
- 安装 [atomcode](https://crates.io/crates/atomcode) CLI：
  ```bash
  cargo install atomcode
  ```

---

## 快速开始

```bash
# 克隆
git clone https://github.com/tev6/atomcode-gui.git
cd atomcode-gui

# 安装依赖
npm install

# 启动
npm start
```

GUI 会自动检查 `atomcode` 二进制文件。如果找到，你可以立即开始对话。

---

## 项目结构

```
atomcode-gui/
├── main.js          # Electron 主进程（窗口、IPC、子进程管理）
├── preload.js       # 上下文桥接（向渲染进程暴露安全 API）
├── renderer.js      # UI 逻辑（流式渲染、事件处理、DOM 管理）
├── index.html       # 布局 & CSS 变量（暗色主题）
├── package.json
├── LICENSE
├── README.md
└── README_zh.md
```

---

## 架构

应用启动一个 `atomcode` 子进程，将完整对话历史作为 `-p` 参数传入：

```
渲染进程 (renderer.js)
  │  IPC: atomcode:query
  ▼
主进程 (main.js)
  │  spawn('atomcode', ['-p', prompt, '-C', cwd, '--verbose'])
  │
  ├── stdout → [response_chunk]（流式 AI 文本）
  └── stderr → [thinking] [tool→] [tool←] [done]（结构化元数据）
```

标准错误输出流按行解析为结构化事件（`[thinking]`、`[tool→ name args=...]`、`[tool← name OK time]`、`[done]`），标准输出携带原始的 AI 回复。两个流都通过 Electron IPC 转发到渲染进程。

---

## 许可

[MIT](LICENSE)

---

*本项目 100% 由 AI 开发 —— 从第一行代码到这份 README。*
