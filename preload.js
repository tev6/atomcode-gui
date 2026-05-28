const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atomcode', {
  // ─── Shell ─────────────────────────────────────
  exec: (command, cwd) => ipcRenderer.invoke('shell:exec', { command, cwd }),

  // ─── File system ────────────────────────────────
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),
  listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
  search: (pattern, rootDir) => ipcRenderer.invoke('fs:search', { pattern, rootDir }),

  // ─── App info ──────────────────────────────────
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),

  // ─── Platform ─────────────────────────────────
  platform: process.platform,

  // ─── AtomCode Daemon API ────────────────────────
  // 通过 POST /chat + SSE 流式聊天

  /** 发送消息，返回 { sessionId } */
  query: (params) => ipcRenderer.invoke('atomcode:query', params),

  /** 取消当前聊天 */
  cancel: (sessionId) => ipcRenderer.invoke('atomcode:cancel', sessionId),

  /** 检查 atomcode daemon 是否可用 */
  check: () => ipcRenderer.invoke('atomcode:check'),

  /** 获取 daemon 运行状态 */
  getDaemonStatus: () => ipcRenderer.invoke('atomcode:daemonStatus'),

  /** 监听主进程事件（SSE 事件转发 / daemon 状态更新） */
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('atomcode:event', handler);
    return () => ipcRenderer.removeListener('atomcode:event', handler);
  },

  // ─── 会话管理 ───────────────────────────────────
  /** 列出所有会话 */
  listSessions: () => ipcRenderer.invoke('atomcode:listSessions'),

  /** 删除会话 */
  deleteSession: (projectHash, sessionId) =>
    ipcRenderer.invoke('atomcode:deleteSession', { projectHash, sessionId }),

  /** 重命名会话 */
  renameSession: (projectHash, sessionId, name) =>
    ipcRenderer.invoke('atomcode:renameSession', { projectHash, sessionId, name }),

  // ─── 模型 / Provider ────────────────────────────
  /** 列出可用模型 */
  listModels: () => ipcRenderer.invoke('atomcode:listModels'),

  /** 列出 Provider */
  listProviders: () => ipcRenderer.invoke('atomcode:listProviders'),

  // ─── 项目 ──────────────────────────────────────
  /** 获取当前项目状态 */
  getProject: () => ipcRenderer.invoke('atomcode:getProject'),

  /** 修改工作目录 */
  changeDir: (dir) => ipcRenderer.invoke('atomcode:changeDir', dir),
});
