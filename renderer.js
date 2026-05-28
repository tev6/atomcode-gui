// ─── AtomCode GUI Renderer（Daemon SSE 模式）───────
// 通过 Electron IPC 连接 atomcode daemon

const chatContainer = document.getElementById('chat-container');
const welcome = document.getElementById('welcome');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const statusText = document.getElementById('status-text');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const cwdInput = document.getElementById('cwd-input');
const atomcodeStatus = document.getElementById('atomcode-status');
const atomcodePathEl = document.getElementById('atomcode-path');
const sessionList = document.getElementById('session-list');
const newSessionBtn = document.getElementById('new-session-btn');

// ─── State ─────────────────────────────────────────────
const state = {
  sessions: [],        // { id, name, created_at, updated_at, message_count }
  activeSessionId: null, // daemon session UUID
  messages: [],
  isLoading: false,
  currentSessionId: null, // 用于追踪 SSE 事件流
  atomcodeAvailable: false,
  daemonRunning: false,
  cwd: '',
  projects: {},        // projectHash → session list cache
};

// AI 回复流式累积
let currentAiBubble = null;
let currentText = '';
let currentThinkingEl = null;
let unlisten = null;
let hasToolCalls = false;

// ─── 会话管理（通过 daemon API）──────────────────

async function loadSessionsFromDaemon() {
  try {
    const sessions = await window.atomcode.listSessions();
    state.sessions = sessions || [];
    renderSessionList();
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function activeSessionIdLoad() {
  return localStorage.getItem('atomcode_active_session') || null;
}

function activeSessionIdSave(id) {
  if (id) localStorage.setItem('atomcode_active_session', id);
  else localStorage.removeItem('atomcode_active_session');
}

function sessionCreate() {
  // Daemon 管理会话，本地只需创建一个空占位
  const session = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: '新对话',
    messages: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    message_count: 0,
    _pending: true, // 标记为待创建（daemon 会在第一个 chat 后生成）
  };
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  state.messages = [];
  activeSessionIdSave(session.id);
  renderSessionList();
  clearChatUI();
  welcome.classList.remove('hidden');
  return session;
}

async function sessionDelete(id) {
  // 通过 daemon API 删除
  const session = state.sessions.find(s => s.id === id);
  if (!session) return;

  // 如果是 pending 会话，直接从本地删除
  if (session._pending) {
    state.sessions = state.sessions.filter(s => s.id !== id);
    if (state.activeSessionId === id) {
      if (state.sessions.length > 0) {
        sessionSwitch(state.sessions[0].id);
      } else {
        sessionCreate();
      }
    }
    renderSessionList();
    return;
  }

  // 需要从 daemon 删除：先找 projectHash
  // 从所有会话列表中查找
  let projectHash = null;
  try {
    const allSessions = await window.atomcode.listSessions();
    const found = allSessions.find(s => s.id === id);
    if (found && found.project_hash) projectHash = found.project_hash;
  } catch {}

  if (projectHash) {
    await window.atomcode.deleteSession(projectHash, id);
  }

  state.sessions = state.sessions.filter(s => s.id !== id);
  if (state.activeSessionId === id) {
    if (state.sessions.length > 0) {
      sessionSwitch(state.sessions[0].id);
    } else {
      sessionCreate();
    }
  }
  renderSessionList();
}

async function sessionSwitch(id) {
  sessionSaveCurrent();
  const session = state.sessions.find(s => s.id === id);
  if (!session) return;

  state.activeSessionId = id;
  activeSessionIdSave(id);

  // 如果是 daemon 管理的会话，尝试加载详情
  if (!session._pending) {
    try {
      const allSessions = await window.atomcode.listSessions();
      const found = allSessions.find(s => s.id === id);
      if (found && found.project_hash) {
        const detail = await getSessionDetail(found.project_hash, id);
        if (detail && detail.messages) {
          session.messages = detail.messages.map(m => ({
            role: m.role,
            content: m.content || '',
          }));
        }
      }
    } catch {}
  }

  state.messages = session.messages || [];
  renderMessages(state.messages);
  renderSessionList();
}

async function getSessionDetail(projectHash, id) {
  try {
    const sessions = await window.atomcode.listSessions();
    const found = sessions.find(s => s.id === id);
    if (found) return found;
  } catch {}
  return null;
}

function sessionSaveCurrent() {
  // 更新本地缓存
  const session = state.sessions.find(s => s.id === state.activeSessionId);
  if (!session) return;
  session.messages = state.messages;
  session.updated_at = Date.now();
  // 自动命名
  if (session.name === '新对话' || !session.name) {
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    if (firstUserMsg && firstUserMsg.content) {
      session.name = firstUserMsg.content.substring(0, 30);
    }
  }
}

function renderSessionList() {
  sessionList.innerHTML = '';
  state.sessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item';
    if (session.id === state.activeSessionId) {
      item.classList.add('active');
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-title';
    titleSpan.textContent = session.name || '新对话';

    const delBtn = document.createElement('button');
    delBtn.className = 'session-delete';
    delBtn.textContent = '✕';
    delBtn.title = '删除会话';

    item.appendChild(titleSpan);
    item.appendChild(delBtn);

    item.addEventListener('click', (e) => {
      if (e.target === delBtn) return;
      if (session.id !== state.activeSessionId) {
        sessionSwitch(session.id);
      }
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionDelete(session.id);
    });

    sessionList.appendChild(item);
  });
}

function clearChatUI() {
  const msgs = chatContainer.querySelectorAll('.msg, .tool-call, .tool-result, .artifact');
  msgs.forEach(el => el.remove());
  welcome.classList.add('hidden');
}

function renderMessages(messages) {
  clearChatUI();
  if (!messages || messages.length === 0) {
    welcome.classList.remove('hidden');
    return;
  }
  messages.forEach(msg => {
    if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
      addMessage(msg.role, msg.content);
    }
  });
}

// ─── 新会话按钮 ─────────────────────────────────
newSessionBtn.addEventListener('click', () => {
  sessionCreate();
});

// ─── 检查 atomcode daemon ──────────────────────
async function checkAtomcode() {
  try {
    const result = await window.atomcode.check();
    state.atomcodeAvailable = result.available;
    state.daemonRunning = result.daemonRunning;
    if (result.available && result.daemonRunning) {
      atomcodeStatus.textContent = '✅ Daemon 就绪';
      atomcodeStatus.style.color = 'var(--success)';
      atomcodePathEl.textContent = `127.0.0.1:${result.health ? '13456' : '?'}`;
      setStatus('就绪');
      sendBtn.disabled = false;
    } else if (result.available) {
      atomcodeStatus.textContent = '⏳ Daemon 启动中…';
      atomcodeStatus.style.color = 'var(--warning)';
      atomcodePathEl.textContent = '等待 daemon 就绪';
      setStatus('⏳ 等待 daemon…');
      sendBtn.disabled = true;
    } else {
      // 未安装或启动失败 — 显示详细诊断信息
      const errMsg = result.daemonError || '';
      const paths = result.searchPaths || {};

      let details = '';
      if (errMsg) {
        details += `\n错误: ${errMsg}`;
      }
      details += `\n查找路径:`;
      details += `\n  atomcode-daemon: ${paths.atomcodeDaemon || '未找到'}`;
      details += `\n  atomcode CLI: ${paths.atomcodeCli || '未找到'}`;
      details += `\n  cargo bin 目录: ${paths.cargoBinDir || '?'}`;
      if (paths.atomcodeDaemon && paths.atomcodeDaemon !== 'atomcode-daemon' && !errMsg) {
        // 找到了 daemon 二进制但启动超时
        details += '\n\n✅ 已找到 atomcode-daemon 二进制，但启动超时';
        details += '\n可能原因: 端口 13456 被占用 / daemon 启动报错';
        details += '\n请在开发者工具 Console 中查看详细日志';
      } else if (!errMsg) {
        details += '\n💡 需要安装 atomcode-daemon：';
        details += '\n   cargo install atomcode-daemon';
        details += '\n\n或确保 atomcode 在 PATH 中：';
        details += '\n   $env:Path += ";$env:USERPROFILE\\.cargo\\bin"';
      }

      atomcodeStatus.textContent = '❌ Daemon 不可用';
      atomcodeStatus.style.color = 'var(--error)';
      atomcodePathEl.textContent = '';
      atomcodePathEl.title = details;
      setStatus('⚠️ atomcode 未就绪 — 鼠标悬停查看详情', true);

      // 在设置面板中显示诊断信息
      const existingDiag = document.getElementById('daemon-diagnostic');
      if (existingDiag) existingDiag.remove();

      const diag = document.createElement('div');
      diag.id = 'daemon-diagnostic';
      diag.className = 'settings-row';
      diag.style.flexDirection = 'column';
      diag.style.alignItems = 'flex-start';
      diag.style.gap = '4px';
      const label = document.createElement('label');
      label.style.minWidth = 'auto';
      label.textContent = '诊断';
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-size:11px;color:var(--error);white-space:pre-wrap;margin:0;background:var(--bg);padding:8px;border-radius:4px;width:100%;';
      pre.textContent = details;
      diag.appendChild(label);
      diag.appendChild(pre);
      settingsPanel.appendChild(diag);

      sendBtn.disabled = true;
    }
  } catch (err) {
    atomcodeStatus.textContent = '❌ 检查失败';
    atomcodeStatus.style.color = 'var(--error)';
    setStatus('❌ daemon 检查失败', true);
  }
}

// ─── 初始化工作目录 ──────────────────────────────
async function initCwd() {
  try {
    // 优先从 daemon 获取
    const project = await window.atomcode.getProject();
    if (project && project.working_dir) {
      state.cwd = project.working_dir;
    } else {
      state.cwd = await window.atomcode.getPath('home');
    }
  } catch {
    state.cwd = 'C:\\';
  }
  cwdInput.value = state.cwd;
  cwdInput.addEventListener('change', () => {
    state.cwd = cwdInput.value.trim() || state.cwd;
  });
}

// ─── Auto-resize textarea ─────────────────────────
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
  sendBtn.disabled = !messageInput.value.trim() || state.isLoading;
});

// ─── Settings toggle ──────────────────────────────
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

// ─── 发送消息 ─────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || state.isLoading) return;

  // 如果没有活跃会话，先创建一个
  if (!state.activeSessionId) {
    sessionCreate();
  }

  if (!state.daemonRunning) {
    addMessage('system', '⚠️ AtomCode daemon 未就绪。正在启动…');
    // 尝试重新检查
    await checkAtomcode();
    if (!state.daemonRunning) {
      addMessage('system', '❌ daemon 无法连接，请确认 atomcode 已正确安装');
      return;
    }
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';
  sendBtn.disabled = true;

  // 添加用户消息
  addMessage('user', text);
  state.messages.push({ role: 'user', content: text });

  // 显示 typing indicator
  showTyping();

  // 隐藏 welcome
  welcome.classList.add('hidden');

  state.isLoading = true;
  state.currentSessionId = state.activeSessionId;

  try {
    await window.atomcode.query({
      sessionId: state.currentSessionId,
      message: text,
      cwd: state.cwd,
    });
  } catch (err) {
    removeTyping();
    addMessage('system', `❌ ${err.message}`);
    state.isLoading = false;
    sendBtn.disabled = !messageInput.value.trim();
  }
}

// ─── 事件监听（主进程 → 渲染进程） ────────────────
function setupEventListener() {
  if (unlisten) unlisten();

  unlisten = window.atomcode.onEvent((event) => {
    const { sessionId, type } = event;

    // daemon_status 是全局事件，不由 sessionId 过滤
    if (type === 'daemon_status') {
      state.daemonRunning = event.running;
      if (event.running) {
        atomcodeStatus.textContent = '✅ Daemon 就绪';
        atomcodeStatus.style.color = 'var(--success)';
        setStatus('就绪');
        sendBtn.disabled = false;
        // 加载会话列表
        loadSessionsFromDaemon();
      } else {
        atomcodeStatus.textContent = '❌ Daemon 断开';
        atomcodeStatus.style.color = 'var(--error)';
      }
      return;
    }

    // 以下事件按 sessionId 过滤
    if (sessionId !== state.currentSessionId) return;

    switch (type) {

      case 'text':
      case 'reasoning': {
        if (type === 'reasoning') {
          // reasoning/thinking 内容
          if (!currentThinkingEl) {
            currentThinkingEl = document.createElement('div');
            currentThinkingEl.className = 'msg ai';
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.style.fontSize = '12px';
            bubble.style.color = 'var(--text-dim)';
            bubble.style.fontStyle = 'italic';
            currentThinkingEl.appendChild(bubble);
            chatContainer.appendChild(currentThinkingEl);
          }
          currentThinkingEl.querySelector('.bubble').textContent = `🤔 ${event.content}`;
          scrollToBottom();
        } else {
          // assistant text delta
          currentText += event.content;
          if (!currentAiBubble) {
            removeTyping();
            currentAiBubble = createAiBubble();
          }
          currentAiBubble.querySelector('.bubble').innerHTML = renderMarkdown(currentText);
          scrollToBottom();
        }
        break;
      }

      case 'tool_batch': {
        // 该轮所有工具调用
        if (event.calls && event.calls.length > 0) {
          hasToolCalls = true;
          for (const call of event.calls) {
            addToolCallUI(call.name, call.arguments);
          }
        }
        break;
      }

      case 'tool_start': {
        hasToolCalls = true;
        setStatus(`执行工具: ${event.name}`);
        // 如果 tool_batch 没覆盖到这步
        break;
      }

      case 'tool_result': {
        addToolResultUI(event.name, event.output, event.success, event.duration_ms);
        break;
      }

      case 'artifact_start': {
        // 代码块 / HTML / SVG 开始
        const artifactDiv = document.createElement('div');
        artifactDiv.className = 'artifact';
        artifactDiv.dataset.artifactId = event.id;
        artifactDiv.dataset.artifactType = event.artifact_type;
        artifactDiv.innerHTML = `
          <div class="artifact-header">📄 ${event.title || event.artifact_type || '代码'}</div>
          <pre class="artifact-code"><code></code></pre>
        `;
        if (currentAiBubble) {
          chatContainer.insertBefore(artifactDiv, currentAiBubble);
        } else {
          chatContainer.appendChild(artifactDiv);
        }
        scrollToBottom();
        break;
      }

      case 'artifact_content': {
        // artifact 内容增量
        const artifactDiv = chatContainer.querySelector(`[data-artifact-id="${event.id}"]`);
        if (artifactDiv) {
          const codeEl = artifactDiv.querySelector('.artifact-code code');
          if (codeEl) {
            codeEl.textContent += event.content;
          }
        }
        break;
      }

      case 'artifact_end': {
        // artifact 结束，可以做语法高亮
        break;
      }

      case 'tokens': {
        setStatus(`Token: ${event.prompt} → ${event.completion} (总计 ${event.total})`);
        break;
      }

      case 'done': {
        // 聊天完成
        if (currentText.trim()) {
          state.messages.push({ role: 'assistant', content: currentText });
        }

        // 更新 session 信息
        if (event.session_id) {
          const session = state.sessions.find(s => s.id === state.activeSessionId);
          if (session) {
            session._pending = false;
            session.name = session.name || '新对话';
          }
        }

        setStatus(`完成 (${event.tool_calls || 0} 工具调用, ${event.tokens || 0} tokens)`);
        sessionSaveCurrent();
        // 刷新会话列表
        loadSessionsFromDaemon();
        resetSession();
        break;
      }

      case 'stopped': {
        // 用户取消
        if (currentText.trim()) {
          state.messages.push({ role: 'assistant', content: currentText });
        }
        sessionSaveCurrent();
        loadSessionsFromDaemon();
        resetSession();
        setStatus('已取消');
        break;
      }

      case 'close': {
        // 连接关闭（未收到 done/stopped/error）
        if (state.isLoading) {
          if (currentText.trim()) {
            state.messages.push({ role: 'assistant', content: currentText });
          }
          sessionSaveCurrent();
          loadSessionsFromDaemon();
          resetSession();
        }
        break;
      }

      case 'error': {
        addMessage('system', `❌ ${event.message}`);
        if (currentText.trim()) {
          state.messages.push({ role: 'assistant', content: currentText });
        }
        sessionSaveCurrent();
        loadSessionsFromDaemon();
        resetSession();
        break;
      }
    }
  });
}

function resetSession() {
  state.isLoading = false;
  state.currentSessionId = null;
  currentAiBubble = null;
  currentText = '';
  currentThinkingEl = null;
  hasToolCalls = false;
  sendBtn.disabled = !messageInput.value.trim();
}

// ─── UI 工具函数 ─────────────────────────────────

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'ai'}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? '你' : role === 'system' ? '系统' : 'AtomCode';
  div.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'ai') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  div.appendChild(bubble);

  chatContainer.appendChild(div);
  scrollToBottom();
  return div;
}

function createAiBubble() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'AtomCode';
  div.appendChild(label);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  div.appendChild(bubble);
  chatContainer.appendChild(div);
  return div;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.id = 'typing-msg';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'AtomCode';
  div.appendChild(label);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  div.appendChild(bubble);
  chatContainer.appendChild(div);
  scrollToBottom();
}

function removeTyping() {
  const el = document.getElementById('typing-msg');
  if (el) el.remove();
}

function addToolCallUI(name, args) {
  const div = document.createElement('div');
  div.className = 'tool-call';
  let argsDisplay = '';
  if (typeof args === 'string') {
    try { argsDisplay = JSON.stringify(JSON.parse(args), null, 2); }
    catch { argsDisplay = args; }
  } else if (args) {
    argsDisplay = JSON.stringify(args, null, 2);
  }
  div.innerHTML = `
    <div class="tc-header">🔧 ${name}</div>
    <div class="tc-args">${escapeHtml(argsDisplay)}</div>
  `;
  if (currentAiBubble) {
    chatContainer.insertBefore(div, currentAiBubble);
  } else {
    chatContainer.appendChild(div);
  }
  scrollToBottom();
}

function addToolResultUI(toolName, content, success, durationMs) {
  const div = document.createElement('div');
  div.className = success ? 'tool-result' : 'tool-error';
  const displayText = content ? content.substring(0, 2000) : '(无输出)';
  const suffix = content && content.length > 2000 ? '…（截断）' : '';
  const duration = durationMs ? ` (${(durationMs / 1000).toFixed(1)}s)` : '';
  div.textContent = success
    ? `[${toolName}]${duration} ${displayText}${suffix}`
    : `[${toolName}] ❌ ${displayText}${suffix}`;
  if (currentAiBubble) {
    chatContainer.insertBefore(div, currentAiBubble);
  } else {
    chatContainer.appendChild(div);
  }
  scrollToBottom();
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.style.color = isError ? 'var(--error)' : '';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Markdown 渲染 ──────────────────────────
let _md = null;
function getMd() {
  if (!_md && typeof window.markdownit === 'function') {
    _md = window.markdownit({ html: false, linkify: true, typographer: true });
  }
  return _md;
}

function renderMarkdown(text) {
  const md = getMd();
  const html = md ? md.render(text) : escapeHtml(text);
  return `<div class="markdown-body">${html}</div>`;
}

// ─── 快捷键 ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.isLoading && state.currentSessionId) {
    window.atomcode.cancel(state.currentSessionId);
    if (currentText.trim()) {
      state.messages.push({ role: 'assistant', content: currentText });
    }
    sessionSaveCurrent();
    loadSessionsFromDaemon();
    resetSession();
    setStatus('已取消');
  }
});

// ─── 初始化 ──────────────────────────────────────
async function init() {
  setupEventListener();
  await initCwd();
  await checkAtomcode();

  // 如果 daemon 已就绪，加载会话列表；否则用本地 fallback
  if (state.daemonRunning) {
    await loadSessionsFromDaemon();
  }

  const savedActiveId = activeSessionIdLoad();
  if (savedActiveId && state.sessions.some(s => s.id === savedActiveId)) {
    state.activeSessionId = savedActiveId;
    const session = state.sessions.find(s => s.id === savedActiveId);
    if (session && session.messages) {
      state.messages = session.messages;
      renderMessages(state.messages);
    }
  } else {
    sessionCreate();
  }
  renderSessionList();

  // 轮询 daemon 状态（如果还没就绪）
  if (!state.daemonRunning) {
    const pollInterval = setInterval(async () => {
      const result = await window.atomcode.check();
      if (result.daemonRunning) {
        state.daemonRunning = true;
        atomcodeStatus.textContent = '✅ Daemon 就绪';
        atomcodeStatus.style.color = 'var(--success)';
        setStatus('就绪');
        sendBtn.disabled = false;
        await loadSessionsFromDaemon();
        clearInterval(pollInterval);
      }
    }, 2000);
  }

  console.log('AtomCode GUI — Daemon SSE 模式');
  console.log(`Platform: ${window.atomcode.platform}`);
}

init();
