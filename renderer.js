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
const modelSelect = document.getElementById('model-select');
const manageProvidersBtn = document.getElementById('manage-providers-btn');
const configPathDisplay = document.getElementById('config-path-display');
const versionDisplay = document.getElementById('version-display');

// ─── Provider Modal Elements ───────────────────
const providerModal = document.getElementById('provider-modal');
const providersList = document.getElementById('providers-list');
const providerForm = document.getElementById('provider-form');
const providerFormTitle = document.getElementById('provider-form-title');
const pfName = document.getElementById('pf-name');
const pfType = document.getElementById('pf-type');
const pfApiKey = document.getElementById('pf-api-key');
const pfBaseUrl = document.getElementById('pf-base-url');
const pfSave = document.getElementById('pf-save');
const pfCancel = document.getElementById('pf-cancel');
const providersModalClose = document.getElementById('providers-modal-close');

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
  currentMode: 'build',  // 'build' | 'plan'
  selectedProvider: '',   // provider name for chat
  models: [],
  providers: [],
  defaultProvider: '',
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
    const daemonIds = new Set((sessions || []).map(s => s.id));
    // 保留本地会话（daemon 可能在首次 chat 后还没持久化该会话）
    const localOnly = state.sessions.filter(s => !daemonIds.has(s.id) && !daemonIds.has(s._serverId));
    const merged = (sessions || []).map(ds => {
      // 优先匹配本地已有会话（通过 id 或 _serverId）
      const existing = state.sessions.find(s => s.id === ds.id || s._serverId === ds.id);
      if (existing) {
        // 如果本地会话有 _serverId 且与 daemon ID 不同，说明首次 chat 已完成
        // 用 daemon ID 更新本地 session 的主 ID
        if (existing._serverId && existing.id !== ds.id) {
          existing.id = ds.id;
          delete existing._serverId;
        }
        return existing;
      }
      return ds;
    });
    state.sessions = [...localOnly, ...merged];
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

  // 1) 优先从 localStorage 恢复（支持重启后恢复）
  const localMsgs = loadMessagesLocally(id);
  if (localMsgs) {
    session.messages = localMsgs;
  } else if (!session._pending) {
    // 2) 非 pending 会话：尝试从 daemon 加载消息
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
  saveMessagesLocally(session.id, state.messages);
  // 自动命名
  if (session.name === '新对话' || !session.name) {
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    if (firstUserMsg && firstUserMsg.content) {
      session.name = firstUserMsg.content.substring(0, 30);
    }
  }
}

// ─── 本地消息持久化 (localStorage) ─────────────
function saveMessagesLocally(id, messages) {
  try {
    localStorage.setItem(`chat_msgs_${id}`, JSON.stringify(messages));
  } catch {}
}
function loadMessagesLocally(id) {
  try {
    const raw = localStorage.getItem(`chat_msgs_${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
    titleSpan.dataset.sessionId = session.id;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'session-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-rename';
    renameBtn.textContent = '✎';
    renameBtn.title = '重命名';

    const delBtn = document.createElement('button');
    delBtn.className = 'session-delete';
    delBtn.textContent = '✕';
    delBtn.title = '删除会话';

    actionsDiv.appendChild(renameBtn);
    actionsDiv.appendChild(delBtn);

    item.appendChild(titleSpan);
    item.appendChild(actionsDiv);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.session-actions')) return;
      if (session.id !== state.activeSessionId) {
        sessionSwitch(session.id);
      }
    });

    // 右键菜单
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showSessionContextMenu(e.clientX, e.clientY, session);
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确定删除此对话？')) {
        sessionDelete(session.id);
      }
    });

    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionRenameInline(session.id);
    });

    sessionList.appendChild(item);
  });
}

// ─── 会话右键菜单 ─────────────────────────────
let contextMenuEl = null;
function showSessionContextMenu(x, y, session) {
  hideSessionContextMenu();
  const menu = document.createElement('div');
  menu.className = 'session-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const renameItem = document.createElement('div');
  renameItem.className = 'ctx-item';
  renameItem.textContent = '重命名';
  renameItem.addEventListener('click', () => { hideSessionContextMenu(); sessionRenameInline(session.id); });

  const deleteItem = document.createElement('div');
  deleteItem.className = 'ctx-item';
  deleteItem.textContent = '删除';
  deleteItem.addEventListener('click', () => { hideSessionContextMenu(); if (confirm('确定删除此对话？')) sessionDelete(session.id); });

  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);
  contextMenuEl = menu;

  setTimeout(() => document.addEventListener('click', hideSessionContextMenu, { once: true }), 0);
}
function hideSessionContextMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

/** 行内重命名：将会话标题替换为输入框 */
function sessionRenameInline(id) {
  const session = state.sessions.find(s => s.id === id);
  if (!session) { console.warn('rename: session not found', id); return; }

  const titleSpan = sessionList.querySelector(`.session-title[data-session-id="${id}"]`);
  if (!titleSpan) { console.warn('rename: title element not found', id); return; }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || '';
  input.maxLength = 100;

  // 用 input 替换 title
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  const finish = (save) => {
    if (save) {
      const name = input.value.trim();
      if (name && name !== (session.name || '')) {
        session.name = name;
        // 异步同步到 daemon（不阻塞、不影响本地）
        sessionRenameSync(session).catch(() => {});
      }
    }
    renderSessionList();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { finish(false); }
  });
}

/** 异步同步重命名到 daemon */
async function sessionRenameSync(session) {
  try {
    const allSessions = await window.atomcode.listSessions();
    const found = allSessions.find(s => s.id === session.id || s.id === session._serverId);
    if (found && found.project_hash) {
      await window.atomcode.renameSession(found.project_hash, session.id, session.name);
    }
  } catch (err) {
    console.warn('rename sync failed', err);
  }
}

// ─── 模型 & 提供商加载 ────────────────────────
async function loadModelsProviders() {
  // 加载模型列表
  try {
    const models = await window.atomcode.listModels();
    state.models = Array.isArray(models) ? models : [];
    const modelsEl = document.getElementById('models-display');
    if (modelsEl) {
      modelsEl.textContent = state.models.length > 0
        ? state.models.map(m => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') return m.name || m.id || m.model || JSON.stringify(m);
            return String(m);
          }).join(', ')
        : '（无）';
    }

    // 填充模型下拉框
    modelSelect.innerHTML = '<option value="">默认模型</option>';
    if (state.models.length > 0) {
      for (const m of state.models) {
        const name = (typeof m === 'string') ? m : (m.name || m.id || m.model || '');
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        modelSelect.appendChild(option);
      }
    }
  } catch {
    document.getElementById('models-display').textContent = '加载失败';
  }

  // 加载 Provider 列表
  try {
    const providers = await window.atomcode.listProviders();
    const list = providers.providers || providers;
    state.providers = Array.isArray(list) ? list : [];
    state.defaultProvider = providers.default_provider || '';

    const providersEl = document.getElementById('providers-display');
    if (providersEl) {
      providersEl.textContent = state.providers.length > 0
        ? state.providers.map(p => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object') return p.name || p.id || JSON.stringify(p);
            return String(p);
          }).join(', ')
        : '（无）';
    }

    // 如果有默认 provider，选中它
    if (state.defaultProvider && !state.selectedProvider) {
      state.selectedProvider = state.defaultProvider;
    }
  } catch {
    document.getElementById('providers-display').textContent = '加载失败';
  }
}

// ─── Provider 管理 ────────────────────────────
let editingProviderName = null; // null = 新增, string = 编辑

async function openProviderModal() {
  editingProviderName = null;
  providerForm.style.display = 'none';
  providersList.innerHTML = '<p style="color: var(--text-dim);">加载中...</p>';
  providerModal.style.display = 'flex';
  await renderProviders();
}

function closeProviderModal() {
  providerModal.style.display = 'none';
  editingProviderName = null;
  providerForm.style.display = 'none';
  providerFormTitle.textContent = '新增 Provider';
  pfName.value = '';
  pfType.value = 'openai';
  pfApiKey.value = '';
  pfBaseUrl.value = '';
  pfName.disabled = false;
}

async function renderProviders() {
  try {
    const providers = await window.atomcode.listProviders();
    const list = providers.providers || providers;
    state.providers = Array.isArray(list) ? list : [];
    state.defaultProvider = providers.default_provider || '';

    if (state.providers.length === 0) {
      providersList.innerHTML = `<div style="text-align:center;padding:20px;">
        <p style="color:var(--text-dim);margin:0 0 12px 0;">暂无 Provider</p>
        <button class="add-provider-btn" id="show-add-provider-btn">+ 新增 Provider</button>
      </div>`;
      const addBtn = document.getElementById('show-add-provider-btn');
      if (addBtn) addBtn.addEventListener('click', showAddProviderForm);
      return;
    }

    let html = '<button class="add-provider-btn" id="show-add-provider-btn">+ 新增 Provider</button>';
    for (const p of state.providers) {
      const name = p.name || p.id || '?';
      const ptype = p.provider_type || p.type || '';
      const isDefault = name === state.defaultProvider;
      html += `<div class="provider-item">
        <div class="info">
          <div class="name">${escapeHtml(name)} ${isDefault ? '⭐' : ''}</div>
          <div class="detail">${escapeHtml(ptype)}${isDefault ? ' · 默认' : ''}</div>
        </div>
        <div class="actions">
          <button class="btn-edit" data-name="${escapeHtml(name)}">编辑</button>
          ${isDefault ? '' : `<button class="btn-default" data-name="${escapeHtml(name)}">设为默认</button>`}
          <button class="btn-danger btn-delete" data-name="${escapeHtml(name)}">删除</button>
        </div>
      </div>`;
    }
    providersList.innerHTML = html;

    // 绑定事件
    const addBtn = document.getElementById('show-add-provider-btn');
    if (addBtn) addBtn.addEventListener('click', showAddProviderForm);

    providersList.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => editProvider(btn.dataset.name));
    });
    providersList.querySelectorAll('.btn-default').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.atomcode.setDefaultProvider(btn.dataset.name);
        await renderProviders();
        await loadModelsProviders();
      });
    });
    providersList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`确定删除 Provider "${btn.dataset.name}"？`)) return;
        await window.atomcode.deleteProvider(btn.dataset.name);
        await renderProviders();
        await loadModelsProviders();
      });
    });
  } catch (err) {
    providersList.innerHTML = `<p style="color:var(--error);">加载失败: ${err.message}</p>`;
  }
}

function showAddProviderForm() {
  editingProviderName = null;
  providerFormTitle.textContent = '新增 Provider';
  pfName.value = '';
  pfType.value = 'openai';
  pfApiKey.value = '';
  pfBaseUrl.value = '';
  pfName.disabled = false;
  providerForm.style.display = 'block';
}

function editProvider(name) {
  editingProviderName = name;
  providerFormTitle.textContent = `编辑 Provider: ${name}`;
  pfName.value = name;
  pfName.disabled = true; // 编辑时不能改名

  // 查找现有 provider 预填表单
  const p = state.providers.find(x => x.name === name || x.id === name);
  pfType.value = (p && (p.provider_type || p.type)) || 'openai';
  pfApiKey.value = '';
  pfBaseUrl.value = (p && (p.base_url || '')) || '';
  providerForm.style.display = 'block';
}

async function saveProvider() {
  const name = pfName.value.trim();
  const ptype = pfType.value;
  const apiKey = pfApiKey.value.trim();
  const baseUrl = pfBaseUrl.value.trim();

  if (!name) {
    alert('请输入 Provider 名称');
    return;
  }

  const body = {
    name,
    provider_type: ptype,
  };
  if (apiKey) body.api_key = apiKey;
  if (baseUrl) body.base_url = baseUrl;

  try {
    if (editingProviderName) {
      // 编辑
      const patch = {};
      if (apiKey) patch.api_key = apiKey;
      if (baseUrl) patch.base_url = baseUrl;
      await window.atomcode.patchProvider(editingProviderName, patch);
    } else {
      // 新增
      await window.atomcode.createProvider(body);
    }

    closeProviderModal();
    await loadModelsProviders();
  } catch (err) {
    alert(`保存失败: ${err.message}`);
  }
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
      loadModelsProviders();
      loadConfigInfo();
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

function applyTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  const isLight = saved === 'light';
  document.documentElement.classList.toggle('light', isLight);
  const cb = document.getElementById('theme-toggle-checkbox');
  if (cb) cb.checked = isLight;
  const label = cb?.nextElementSibling;
  if (label) label.textContent = isLight ? '浅色模式' : '深色模式';
}

function themeToggle() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  const cb = document.getElementById('theme-toggle-checkbox');
  if (cb) cb.checked = isLight;
  const label = cb?.nextElementSibling;
  if (label) label.textContent = isLight ? '浅色模式' : '深色模式';
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'theme-toggle-checkbox') themeToggle();
});

// ─── 发送消息 ─────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── 模式切换 ─────────────────────────────────────
document.addEventListener('click', (e) => {
  const modeOption = e.target.closest('.mode-option');
  if (!modeOption) return;

  const mode = modeOption.dataset.mode;
  if (!mode || mode === state.currentMode) return;

  state.currentMode = mode;
  document.querySelectorAll('.mode-option').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  setStatus(`模式: ${mode === 'build' ? 'Build（完整执行）' : 'Plan（只读探索）'}`);
});

// ─── 模型选择 ─────────────────────────────────────
modelSelect.addEventListener('change', () => {
  state.selectedProvider = modelSelect.value;
});

// ─── Provider 管理 ─────────────────────────────
manageProvidersBtn.addEventListener('click', openProviderModal);
providersModalClose.addEventListener('click', closeProviderModal);
pfCancel.addEventListener('click', closeProviderModal);
pfSave.addEventListener('click', saveProvider);
providerModal.addEventListener('click', (e) => {
  if (e.target === providerModal) closeProviderModal();
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
    // 确定发送哪个 provider
    const provider = modelSelect.value || state.selectedProvider || undefined;
    // 确定工作模式
    const mode = state.currentMode === 'plan' ? 'atomcode-air' : undefined;

    await window.atomcode.queryWithOptions({
      sessionId: state.currentSessionId,
      message: text,
      cwd: state.cwd,
      provider,
      mode,
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
            // 存储 daemon 的真实 session ID，但不覆盖本地 id
            // 这样 loadSessionsFromDaemon 可以通过 _serverId 匹配
            if (session.id !== event.session_id && !session._serverId) {
              // 迁移 localStorage 中的消息到新 ID
              const oldKey = `chat_msgs_${session.id}`;
              const oldData = localStorage.getItem(oldKey);
              if (oldData) {
                localStorage.setItem(`chat_msgs_${event.session_id}`, oldData);
                localStorage.removeItem(oldKey);
              }
              session._serverId = event.session_id;
              // 更新 localStorage 中的 activeSessionId 为本地 id（保持不变）
              activeSessionIdSave(session.id);
            }
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
// ─── 加载配置信息 ────────────────────────────
async function loadConfigInfo() {
  try {
    const config = await window.atomcode.getConfig();
    if (config && config.settings_path) {
      configPathDisplay.textContent = config.settings_path;
    } else if (config && config.path) {
      configPathDisplay.textContent = config.path;
    }
    if (config && config.version) {
      versionDisplay.textContent = config.version;
    }
  } catch {
    // 静默失败
  }
}

async function init() {
  applyTheme();
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
    // 从 localStorage 恢复消息（重启后可用）
    const localMsgs = loadMessagesLocally(savedActiveId);
    if (localMsgs) {
      state.messages = localMsgs;
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
