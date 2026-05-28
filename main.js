const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow;
const DAEMON_PORT = 13456;
const DAEMON_HOST = '127.0.0.1';

// ─── Daemon 进程管理 ────────────────────────────
let daemonProcess = null;
let daemonRunning = false;
let daemonError = null; // 最近的错误信息，可传给 renderer

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 在 cargo bin 目录和 PATH 中查找二进制文件 */
function findBinary(name) {
  // 1. ~/.cargo/bin/<name>.exe (Windows)
  const cargoBinExe = path.join(app.getPath('home'), '.cargo', 'bin', `${name}.exe`);
  if (fs.existsSync(cargoBinExe)) return cargoBinExe;
  // 2. ~/.cargo/bin/<name> (Unix)
  const cargoBin = path.join(app.getPath('home'), '.cargo', 'bin', name);
  if (fs.existsSync(cargoBin)) return cargoBin;
  // 3. 同目录下（与 Electron 同级）
  const exeDir = path.dirname(app.getPath('exe'));
  const sameDirExe = path.join(exeDir, `${name}.exe`);
  if (fs.existsSync(sameDirExe)) return sameDirExe;
  const sameDir = path.join(exeDir, name);
  if (fs.existsSync(sameDir)) return sameDir;
  // 4. fallback: 靠 PATH 解析
  return name;
}

function getCargoBinDir() {
  return path.join(app.getPath('home'), '.cargo', 'bin');
}

function currentExecDir() {
  return path.dirname(app.getPath('exe'));
}

async function daemonHealthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://${DAEMON_HOST}:${DAEMON_PORT}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * 尝试启动 daemon:
 *   - 优先直接运行 atomcode-daemon (独立二进制)
 *   - 如果不存在，回退到 atomcode daemon (CLI 子命令)
 *   - 捕获 stderr 用于诊断
 */
async function startDaemon() {
  if (daemonRunning) return true;
  daemonError = null;

  // 检查可能路径并记录
  const cargoDir = getCargoBinDir();
  const exeDir = currentExecDir();

  // 尝试 1: 直接 atomcode-daemon
  const daemonBin = findBinary('atomcode-daemon');
  console.log(`[daemon] 尝试启动: ${daemonBin}`);

  // 尝试 2: atomcode daemon (CLI subcommand)
  const cliBin = findBinary('atomcode');

  // 决定用哪个
  let binToUse;
  let argsToUse;
  let sourceDesc;

  if (daemonBin !== 'atomcode-daemon' && fs.existsSync(daemonBin)) {
    // 找到了 atomcode-daemon 二进制
    binToUse = daemonBin;
    argsToUse = ['--port', String(DAEMON_PORT)];
    sourceDesc = `直接启动 daemon: ${daemonBin}`;
  } else if (cliBin !== 'atomcode' && fs.existsSync(cliBin)) {
    // 用 atomcode daemon 子命令
    binToUse = cliBin;
    argsToUse = ['daemon', '--port', String(DAEMON_PORT)];
    sourceDesc = `通过 CLI 子命令: ${cliBin} daemon`;
  } else {
    // PATH 解析
    binToUse = cliBin;
    argsToUse = ['daemon', '--port', String(DAEMON_PORT)];
    sourceDesc = `通过 PATH: ${cliBin} daemon`;
  }

  console.log(`[daemon] ${sourceDesc}`);

  let stderrLog = '';

  daemonProcess = spawn(binToUse, argsToUse, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemonProcess.unref();

  // 捕获 stderr 以便诊断
  if (daemonProcess.stderr) {
    daemonProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrLog += text;
      console.error(`[daemon stderr] ${text.trim()}`);
    });
  }

  daemonProcess.on('error', (err) => {
    daemonError = err.message;
    console.error(`[daemon] 启动错误: ${err.message}`);
  });

  // 等待 daemon 就绪（最多 10 秒）
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const health = await daemonHealthCheck();
    if (health && health.status === 'ok') {
      daemonRunning = true;
      console.log(`[daemon] 已就绪, 端口 ${DAEMON_PORT}`);
      return true;
    }
    // 如果进程已经退出，提前终止
    if (daemonProcess && daemonProcess.killed) {
      break;
    }
  }

  // 收集错误信息
  if (stderrLog) {
    daemonError = stderrLog.trim().split('\n').pop();
  } else if (!daemonError) {
    daemonError = 'daemon 未能在 10 秒内就绪';
  }

  console.error(`[daemon] 启动失败: ${daemonError}`);
  daemonRunning = false;
  return false;
}

/** 获取 daemon 的最近错误日志（用于 UI 显示） */
function getDaemonErrorMessage() {
  return daemonError;
}

async function stopDaemon() {
  if (!daemonRunning && !daemonProcess) return;

  // 发送优雅关闭
  try {
    await new Promise((resolve) => {
      const req = http.request(
        `http://${DAEMON_HOST}:${DAEMON_PORT}/shutdown`,
        { method: 'POST' },
        () => resolve()
      );
      req.on('error', () => resolve());
      req.setTimeout(3000, () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch {}

  // 等待 1 秒后强制 kill
  await sleep(1000);
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill('SIGTERM');
    setTimeout(() => {
      if (daemonProcess && !daemonProcess.killed) daemonProcess.kill('SIGKILL');
    }, 2000);
  }
  daemonRunning = false;
  daemonProcess = null;
}

// ─── HTTP 请求工具 ──────────────────────────────

function daemonRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };
    const json = body ? JSON.stringify(body) : null;
    if (json) opts.headers['Content-Length'] = Buffer.byteLength(json);

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (json) req.write(json);
    req.end();
  });
}

// ─── SSE Chat 流 ────────────────────────────────
// activeChats: clientSessionId → { httpReq, daemonSessionId }
let activeChats = new Map();

function startChatStream(clientSessionId, message, cwd, sendEvent) {
  const body = JSON.stringify({
    message,
    working_dir: cwd || app.getPath('home'),
  });

  const opts = {
    hostname: DAEMON_HOST,
    port: DAEMON_PORT,
    path: '/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'text/event-stream',
    },
  };

  const req = http.request(opts, (res) => {
    let buffer = '';
    let daemonSessionId = null;

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              // 捕获 done 事件中的 session_id
              if (event.type === 'done' && event.session_id) {
                daemonSessionId = event.session_id;
                const entry = activeChats.get(clientSessionId);
                if (entry) entry.daemonSessionId = daemonSessionId;
              }
              // 转发给渲染进程
              sendEvent({ sessionId: clientSessionId, ...event });
            } catch (e) {
              // 忽略非 JSON 行（如 "ping" keepalive）
            }
          }
        }
      }
    });

    res.on('end', () => {
      const entry = activeChats.get(clientSessionId);
      if (entry) {
        // 如果没有收到 done/stopped/error，发送 close
        sendEvent({ sessionId: clientSessionId, type: 'close' });
        activeChats.delete(clientSessionId);
      }
    });

    res.on('error', (err) => {
      sendEvent({ sessionId: clientSessionId, type: 'error', message: err.message });
      activeChats.delete(clientSessionId);
    });
  });

  req.on('error', (err) => {
    sendEvent({ sessionId: clientSessionId, type: 'error', message: err.message });
    activeChats.delete(clientSessionId);
  });

  req.write(body);
  req.end();

  activeChats.set(clientSessionId, { httpReq: req, daemonSessionId: null });
}

// ─── 窗口创建 ──────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'AtomCode',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // 启动 daemon（后台，不阻塞窗口加载）
  startDaemon().then((ok) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('atomcode:event', {
        type: 'daemon_status',
        running: ok,
      });
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  await stopDaemon();
});

// ─── Shell / FS helpers ─────────────────────────

ipcMain.handle('shell:exec', async (_event, { command, cwd }) => {
  return new Promise((resolve) => {
    const proc = spawn('cmd.exe', ['/c', command], {
      cwd: cwd || app.getPath('home'),
      windowsHide: true,
      shell: false,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
});

ipcMain.handle('fs:readFile', async (_event, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf-8') }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('fs:writeFile', async (_event, { filePath, content }) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('fs:listDir', async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('fs:search', async (_event, { pattern, rootDir }) => {
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      `findstr /s /n /c:"${pattern}" "${rootDir}\\*.*"`,
      { cwd: rootDir, timeout: 10000, windowsHide: true }
    );
    return { ok: true, lines: result.toString().split('\r\n').filter(Boolean) };
  } catch (_) { return { ok: true, lines: [] }; }
});

ipcMain.handle('app:getPath', async (_event, name) => {
  return app.getPath(name);
});

// ─── AtomCode Daemon 集成 ───────────────────────

/** 发送事件到渲染进程的辅助函数 */
function sendToRenderer(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('atomcode:event', data);
  }
}

/** 检查 daemon 状态 */
ipcMain.handle('atomcode:check', async () => {
  const health = await daemonHealthCheck();
  const available = !!(daemonRunning || health);
  return {
    available,
    daemonRunning: daemonRunning || !!health,
    health,
    daemonError: daemonError,
    searchPaths: {
      cargoBinDir: getCargoBinDir(),
      execDir: currentExecDir(),
      atomcodeDaemon: findBinary('atomcode-daemon'),
      atomcodeCli: findBinary('atomcode'),
    },
  };
});

/** 获取 daemon 详细状态 */
ipcMain.handle('atomcode:daemonStatus', async () => {
  const health = await daemonHealthCheck();
  return {
    running: daemonRunning || !!health,
    port: DAEMON_PORT,
    health,
  };
});

/** 发送消息（SSE 流式聊天） */
ipcMain.handle('atomcode:query', async (event, { sessionId, message, cwd }) => {
  if (!daemonRunning) {
    // 尝试再启动一次
    const ok = await startDaemon();
    if (!ok) {
      throw new Error('AtomCode daemon 未运行，请确认 atomcode 已安装');
    }
  }

  startChatStream(sessionId, message, cwd, (data) => {
    sendToRenderer(data);
  });

  return { sessionId };
});

/** 取消聊天 */
ipcMain.handle('atomcode:cancel', async (_event, sessionId) => {
  const entry = activeChats.get(sessionId);
  if (!entry) return { ok: false, reason: 'not found' };

  // 如果有 daemon session_id，发 POST /chat/stop
  if (entry.daemonSessionId) {
    try {
      await daemonRequest('POST', '/chat/stop', { session_id: entry.daemonSessionId });
    } catch {}
  }

  // 销毁 HTTP 连接
  try { entry.httpReq.destroy(); } catch {}

  activeChats.delete(sessionId);
  return { ok: true };
});

/** 列出所有会话 */
ipcMain.handle('atomcode:listSessions', async () => {
  try {
    const sessions = await daemonRequest('GET', '/sessions');
    return sessions || [];
  } catch (err) {
    return [];
  }
});

/** 删除会话 */
ipcMain.handle('atomcode:deleteSession', async (_event, { projectHash, sessionId }) => {
  try {
    const result = await daemonRequest('DELETE', `/projects/${projectHash}/sessions/${sessionId}`);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 重命名会话 */
ipcMain.handle('atomcode:renameSession', async (_event, { projectHash, sessionId, name }) => {
  try {
    const result = await daemonRequest('PATCH', `/projects/${projectHash}/sessions/${sessionId}/rename`, { name });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 列出模型 */
ipcMain.handle('atomcode:listModels', async () => {
  try {
    return await daemonRequest('GET', '/models');
  } catch {
    return [];
  }
});

/** 列出 Provider */
ipcMain.handle('atomcode:listProviders', async () => {
  try {
    return await daemonRequest('GET', '/providers');
  } catch {
    return { providers: [], default_provider: '' };
  }
});

/** 获取项目状态（当前工作目录等） */
ipcMain.handle('atomcode:getProject', async () => {
  try {
    return await daemonRequest('GET', '/project');
  } catch {
    return null;
  }
});

/** 修改工作目录 */
ipcMain.handle('atomcode:changeDir', async (_event, dir) => {
  try {
    return await daemonRequest('POST', '/cd', { path: dir });
  } catch (err) {
    return { success: false, message: err.message };
  }
});
