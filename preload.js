const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atomcode', {
  // Shell
  exec: (command, cwd) => ipcRenderer.invoke('shell:exec', { command, cwd }),

  // File system
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),
  listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
  search: (pattern, rootDir) => ipcRenderer.invoke('fs:search', { pattern, rootDir }),

  // App info
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),

  // Platform info
  platform: process.platform,

  // ─── AtomCode 子进程集成 ────────────────────

  /** 向 atomcode 发送查询请求，返回 sessionId */
  query: (params) => ipcRenderer.invoke('atomcode:query', params),

  /** 取消正在运行的查询 */
  cancel: (sessionId) => ipcRenderer.invoke('atomcode:cancel', sessionId),

  /** 检查 atomcode 是否可用 */
  check: () => ipcRenderer.invoke('atomcode:check'),

  /** 监听来自主进程的流式事件 */
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('atomcode:event', handler);
    // 返回取消监听的函数
    return () => ipcRenderer.removeListener('atomcode:event', handler);
  },
});
