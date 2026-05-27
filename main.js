const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let activeProcesses = new Map(); // sessionId → ChildProcess

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'AtomCode',
    icon: path.join(__dirname, 'assets', 'icon.svg'),
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Shell / FS helpers (used by renderer) ─────────────

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

// ─── AtomCode 子进程集成 ────────────────────────────
// 将完整的对话历史作为 prompt 传给 atomcode -p 模式

function buildPrompt(messages) {
  // messages: [{ role: 'user'|'assistant'|'system', content }]
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') continue; // system prompt 由 atomcode 自己管理
    const prefix = msg.role === 'user' ? '用户' : 'AI';
    prompt += `${prefix}：${msg.content}\n\n`;
  }
  prompt += 'AI：'; // 让 AI 继续
  return prompt;
}

// 解析工具调用的 args JSON（atomcode 输出中可能含转义）
function tryParseArgs(raw) {
  try {
    // Remove outer quotes if present
    let s = raw.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    // Unescape double backslashes
    s = s.replace(/\\\\/g, '\\');
    return JSON.parse(s);
  } catch {
    return { raw };
  }
}

ipcMain.handle('atomcode:query', async (event, { sessionId, messages, cwd }) => {
  const prompt = buildPrompt(messages);
  
  // 查找 atomcode 二进制
  const atomcodePath = path.join(app.getPath('home'), '.cargo', 'bin', 'atomcode.exe');
  const bin = fs.existsSync(atomcodePath) ? atomcodePath : 'atomcode';

  const proc = spawn(bin, ['-p', prompt, '-C', cwd || app.getPath('home'), '--verbose'], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeProcesses.set(sessionId, proc);

  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('atomcode:event', { sessionId, type, ...data });
    }
  };

  // stdout = AI 回复文本（流式）
  proc.stdout.on('data', (chunk) => {
    send('response_chunk', { text: chunk.toString() });
  });

  // stderr = 结构化元数据（thinking / tool_call / token / done）
  let metaBuf = '';
  proc.stderr.on('data', (chunk) => {
    metaBuf += chunk.toString();
    const lines = metaBuf.split('\n');
    metaBuf = lines.pop() || ''; // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // [thinking] ...
      if (trimmed.startsWith('[thinking]')) {
        send('thinking', { text: trimmed.slice('[thinking]'.length).trim() });
        continue;
      }

      // [tool-streaming← name]
      const tsMatch = trimmed.match(/^\[tool-streaming←\s*(\S+)\s*\]/);
      if (tsMatch) {
        send('tool_streaming', { name: tsMatch[1] });
        continue;
      }

      // [tool→ name args=...]
      const tCallMatch = trimmed.match(/^\[tool→\s*(\S+)\s+args=(.+)$/);
      if (tCallMatch) {
        send('tool_call', {
          name: tCallMatch[1],
          args: tryParseArgs(tCallMatch[2]),
        });
        continue;
      }

      // [tool← name OK/ERR time] result
      const tResMatch = trimmed.match(/^\[tool←\s*(\S+)\s+(OK|ERR)\s+(\S+)\]\s*(.*)$/);
      if (tResMatch) {
        send('tool_result', {
          name: tResMatch[1],
          status: tResMatch[2].toLowerCase(),
          duration: tResMatch[3],
          text: tResMatch[4],
        });
        continue;
      }

      // [tokens prompt=X completion=Y]
      const tokMatch = trimmed.match(/^\[tokens\]\s+prompt=(\d+)\s+completion=(\d+)/);
      if (tokMatch) {
        send('tokens', { prompt: parseInt(tokMatch[1]), completion: parseInt(tokMatch[2]) });
        continue;
      }

      // [done] time turns=X tool_calls=Y
      const doneMatch = trimmed.match(/^\[done\]\s+([\d.]+)s\s+turns=(\d+)\s+tool_calls=(\d+)/);
      if (doneMatch) {
        send('done', {
          duration: parseFloat(doneMatch[1]),
          turns: parseInt(doneMatch[2]),
          toolCalls: parseInt(doneMatch[3]),
        });
        continue;
      }
    }
  });

  proc.on('close', (code) => {
    activeProcesses.delete(sessionId);
    send('close', { code });
  });

  proc.on('error', (err) => {
    activeProcesses.delete(sessionId);
    send('error', { error: err.message });
  });

  // Return sessionId immediately
  return { sessionId };
});

ipcMain.handle('atomcode:cancel', async (_event, sessionId) => {
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    proc.kill();
    activeProcesses.delete(sessionId);
    return { ok: true };
  }
  return { ok: false, reason: 'not found' };
});

ipcMain.handle('atomcode:check', async () => {
  const atomcodePath = path.join(app.getPath('home'), '.cargo', 'bin', 'atomcode.exe');
  if (fs.existsSync(atomcodePath)) {
    return { available: true, path: atomcodePath };
  }
  // Try PATH
  return new Promise((resolve) => {
    const proc = spawn('where', ['atomcode'], { windowsHide: true });
    proc.on('close', (code) => resolve({ available: code === 0, path: code === 0 ? 'atomcode' : null }));
  });
});
