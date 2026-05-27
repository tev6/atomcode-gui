// ─── AtomCode GUI Renderer ────────────────────────────
// 通过 Electron IPC 调用本地 atomcode 子进程

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

// ─── State ─────────────────────────────────────────────
const state = {
  messages: [],
  isLoading: false,
  currentSessionId: null,
  atomcodeAvailable: false,
  cwd: '',
};

// AI 回复流式累积
let currentAiBubble = null;
let currentText = '';
let currentThinkingEl = null;
let unlisten = null;
let hasToolCalls = false; // 当前会话是否有工具调用

// ─── 检查 atomcode ──────────────────────────────
async function checkAtomcode() {
  try {
    const result = await window.atomcode.check();
    state.atomcodeAvailable = result.available;
    if (result.available) {
      atomcodeStatus.textContent = '✅ 可用';
      atomcodeStatus.style.color = 'var(--success)';
      atomcodePathEl.textContent = result.path;
      setStatus('就绪');
      sendBtn.disabled = false;
    } else {
      atomcodeStatus.textContent = '❌ 未找到';
      atomcodeStatus.style.color = 'var(--error)';
      atomcodePathEl.textContent = '请运行 `cargo install atomcode`';
      setStatus('⚠️ atomcode 未安装', true);
      sendBtn.disabled = true;
    }
  } catch (err) {
    atomcodeStatus.textContent = '❌ 检查失败';
    atomcodeStatus.style.color = 'var(--error)';
    setStatus('❌ atomcode 检查失败', true);
  }
}

// ─── 初始化工作目录 ──────────────────────────────
async function initCwd() {
  try {
    state.cwd = await window.atomcode.getPath('home');
    cwdInput.value = state.cwd;
  } catch {
    state.cwd = 'C:\\';
    cwdInput.value = state.cwd;
  }
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

  if (!state.atomcodeAvailable) {
    addMessage('system', '⚠️ atomcode 未安装。请先运行: `cargo install atomcode`');
    return;
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
  state.currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  try {
    await window.atomcode.query({
      sessionId: state.currentSessionId,
      messages: state.messages,
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
    if (sessionId !== state.currentSessionId) return;

    switch (type) {

      case 'response_chunk':
        currentText += event.text;
        if (!currentAiBubble) {
          removeTyping();
          currentAiBubble = createAiBubble();
        }
        currentAiBubble.querySelector('.bubble').innerHTML = renderMarkdown(currentText);
        scrollToBottom();
        break;

      case 'thinking':
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
        currentThinkingEl.querySelector('.bubble').textContent = `🤔 ${event.text}`;
        scrollToBottom();
        break;

      case 'tool_streaming':
        setStatus(`执行工具: ${event.name}`);
        break;

      case 'tool_call':
        hasToolCalls = true;
        addToolCallUI(event.name, event.args);
        break;

      case 'tool_result':
        addToolResultUI(event.name, event.text, event.status === 'ok');
        break;

      case 'done':
        state.messages.push({ role: 'assistant', content: currentText });
        setStatus(`完成 (${event.duration}s, ${event.turns} 轮, ${event.toolCalls} 工具调用)`);
        resetSession();
        break;

      case 'close':
        if (state.isLoading) {
          if (currentText.trim()) {
            state.messages.push({ role: 'assistant', content: currentText });
          }
          resetSession();
        }
        break;

      case 'error':
        addMessage('system', `❌ ${event.error}`);
        if (currentText.trim()) {
          state.messages.push({ role: 'assistant', content: currentText });
        }
        resetSession();
        break;
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
  div.innerHTML = `
    <div class="tc-header">🔧 ${name}</div>
    <div class="tc-args">${escapeHtml(JSON.stringify(args, null, 2))}</div>
  `;
  if (currentAiBubble) {
    chatContainer.insertBefore(div, currentAiBubble);
  } else {
    chatContainer.appendChild(div);
  }
  scrollToBottom();
}

function addToolResultUI(toolName, content, success) {
  const div = document.createElement('div');
  div.className = success ? 'tool-result' : 'tool-error';
  const displayText = content ? content.substring(0, 2000) : '(无输出)';
  const suffix = content && content.length > 2000 ? '...（截断）' : '';
  div.textContent = `[${toolName}] ${displayText}${suffix}`;
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
    resetSession();
    setStatus('已取消');
  }
});

// ─── 初始化 ──────────────────────────────────────
async function init() {
  setupEventListener();
  await initCwd();
  await checkAtomcode();
  console.log('AtomCode GUI — 本地子进程模式');
  console.log(`Platform: ${window.atomcode.platform}`);
}

init();
