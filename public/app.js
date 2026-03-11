// ─── API Client ──────────────────────────────────────────────────────────────

const api = {
  async _req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },
  async getProjects() { return this._req('GET', '/api/projects'); },
  async createProject(data) { return this._req('POST', '/api/projects', data); },
  async updateProject(id, data) { return this._req('PUT', `/api/projects/${id}`, data); },
  async deleteProject(id) { return this._req('DELETE', `/api/projects/${id}`); },

  async getChats(projectId) {
    const url = projectId ? `/api/chats?projectId=${encodeURIComponent(projectId)}` : '/api/chats';
    return this._req('GET', url);
  },
  async getChat(id) { return this._req('GET', `/api/chats/${id}`); },
  async createChat(data) { return this._req('POST', '/api/chats', data); },
  async updateChat(id, data) { return this._req('PUT', `/api/chats/${id}`, data); },
  async deleteChat(id) { return this._req('DELETE', `/api/chats/${id}`); },

  async getSettings() { return this._req('GET', '/api/settings'); },
  async updateSettings(data) { return this._req('PUT', '/api/settings', data); },

  async getMCPServers() { return this._req('GET', '/api/mcp/servers'); },
  async createMCPServer(data) { return this._req('POST', '/api/mcp/servers', data); },
  async updateMCPServer(id, data) { return this._req('PUT', `/api/mcp/servers/${id}`, data); },
  async deleteMCPServer(id) { return this._req('DELETE', `/api/mcp/servers/${id}`); },
  async connectMCPServer(id) { return this._req('POST', `/api/mcp/servers/${id}/connect`); },
  async disconnectMCPServer(id) { return this._req('POST', `/api/mcp/servers/${id}/disconnect`); },
  async getMCPTools() { return this._req('GET', '/api/mcp/tools'); },

  async getModels() { return this._req('GET', '/api/ollama/models'); },
  async deleteModel(name) { return this._req('DELETE', `/api/ollama/models/${encodeURIComponent(name)}`); },

  async search(query) { return this._req('GET', `/api/search?q=${encodeURIComponent(query)}`); },
  async testTool(name, args) { return this._req('POST', '/api/tools/test', { name, args }); },

  async getRagCollections() { return this._req('GET', '/api/rag/collections'); },
  async getRagCollection(id) { return this._req('GET', `/api/rag/collections/${id}`); },
  async createRagCollection(data) { return this._req('POST', '/api/rag/collections', data); },
  async updateRagCollection(id, data) { return this._req('PUT', `/api/rag/collections/${id}`, data); },
  async deleteRagCollection(id) { return this._req('DELETE', `/api/rag/collections/${id}`); },
  async addRagDocument(collId, data) { return this._req('POST', `/api/rag/collections/${collId}/documents`, data); },
  async deleteRagDocument(collId, docId) { return this._req('DELETE', `/api/rag/collections/${collId}/documents/${docId}`); },
  async queryRag(collId, query, topK) { return this._req('POST', `/api/rag/collections/${collId}/query`, { query, topK }); },

  async searchChats(q) { return this._req('GET', `/api/chats/search?q=${encodeURIComponent(q)}`); },
  async uploadFile(filename, content, mimeType) { return this._req('POST', '/api/upload', { filename, content, mimeType }); },
  async fetchUrlToRag(collId, url) { return this._req('POST', `/api/rag/collections/${collId}/fetch-url`, { url }); },
  async getPresets() { return this._req('GET', '/api/presets'); },
  async createPreset(data) { return this._req('POST', '/api/presets', data); },
  async deletePreset(id) { return this._req('DELETE', `/api/presets/${id}`); },

  async streamChat(chatId, userMessageContent, settings, options, callbacks) {
    const ctrl = new AbortController();
    const body = { chatId, userMessageContent, settings, ...options };
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        callbacks.onError?.(msg);
        return ctrl;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const pump = async () => {
        while (true) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (e.name !== 'AbortError') callbacks.onError?.(e.message);
            break;
          }
          const { done, value } = chunk;
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Parse SSE events
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            if (!part.trim()) continue;
            let eventType = 'message';
            let dataStr = '';
            for (const line of part.split('\n')) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataStr = line.slice(6);
            }
            if (!dataStr) continue;
            let data;
            try { data = JSON.parse(dataStr); } catch { continue; }

            switch (eventType) {
              case 'delta': callbacks.onDelta?.(data.text || ''); break;
              case 'tool_call_start': callbacks.onToolCallStart?.(data); break;
              case 'tool_call_result': callbacks.onToolCallResult?.(data); break;
              case 'tool_calls_done': break;
              case 'rag_status': callbacks.onRagStatus?.(data); break;
              case 'done': callbacks.onDone?.(data); break;
              case 'error': callbacks.onError?.(data.message || 'Unknown error'); break;
            }
          }
        }
      };
      pump();
    } catch (e) {
      if (e.name !== 'AbortError') callbacks.onError?.(e.message);
    }
    return ctrl;
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  projects: [],
  chats: [],
  loadedChats: {},
  settings: {
    ollamaUrl: 'http://localhost:11434',
    model: '',
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    max_tokens: 2048,
    repeat_penalty: 1.1,
    systemPrompt: '',
    ctxLimit: 20,
    webSearch: false,
    searchEngine: 'ddg',
    searxngUrl: '',
    braveApiKey: '',
    tavilyApiKey: '',
    useBuiltinTools: true,
    useMCPTools: true,
    ragEnabled: false,
    ragCollection: '',
    ragTopK: 3,
    ragEmbeddingModel: '',
  },
  models: [],
  mcpServers: [],
  mcpTools: [],
  ragCollections: [],
  panes: [{ id: 'p1', chatId: null, model: null, streaming: false, controller: null, streamText: '', toolCalls: [], pendingImages: [], pendingFile: null }],
  activePaneId: 'p1',
  rightTab: 'chat',
  expandedProjects: new Set(),
  connected: false,
};

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadUIState() {
  try {
    const raw = localStorage.getItem('ollama-tui-ui');
    if (!raw) return;
    const ui = JSON.parse(raw);
    if (ui.expandedProjects) state.expandedProjects = new Set(ui.expandedProjects);
    if (ui.rightTab) {
      // Migrate old tab names
      const tabMap = { settings: 'chat', mcp: 'tools', rag: 'knowledge' };
      state.rightTab = tabMap[ui.rightTab] || ui.rightTab;
    }
    if (ui.panes) {
      state.panes = ui.panes.map(p => ({ ...p, streaming: false, controller: null, streamText: '', toolCalls: [], pendingImages: [], pendingFile: null }));
      state.activePaneId = ui.activePaneId || state.panes[0]?.id || 'p1';
    }
    if (ui.sidebarWidth) document.getElementById('sidebar').style.width = ui.sidebarWidth + 'px';
    if (ui.rightPanelWidth) document.getElementById('right-panel').style.width = ui.rightPanelWidth + 'px';
  } catch {}
}

function saveUIState() {
  try {
    localStorage.setItem('ollama-tui-ui', JSON.stringify({
      expandedProjects: [...state.expandedProjects],
      rightTab: state.rightTab,
      panes: state.panes.map(p => ({ id: p.id, chatId: p.chatId, model: p.model || null })),
      activePaneId: state.activePaneId,
      sidebarWidth: document.getElementById('sidebar').offsetWidth,
      rightPanelWidth: document.getElementById('right-panel').offsetWidth,
    }));
  } catch {}
}

// ─── Notifications ────────────────────────────────────────────────────────────

function ensureNotifContainer() {
  let el = document.getElementById('notifications');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notifications';
    document.body.appendChild(el);
  }
  return el;
}

function notify(message, type = 'ok') {
  const container = ensureNotifContainer();
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ─── Pane Management ──────────────────────────────────────────────────────────

let paneCounter = 2;

function addPane() {
  if (state.panes.length >= 4) { notify('Maximum 4 panes', 'warn'); return; }
  const id = `p${paneCounter++}`;
  state.panes.push({ id, chatId: null, model: null, streaming: false, controller: null, streamText: '', toolCalls: [], pendingImages: [], pendingFile: null });
  state.activePaneId = id;
  renderWorkspace();
  saveUIState();
}

function removePane(paneId) {
  if (state.panes.length <= 1) { notify('Cannot close last pane', 'warn'); return; }
  const pane = state.panes.find(p => p.id === paneId);
  if (pane?.streaming) { pane.controller?.abort(); }
  state.panes = state.panes.filter(p => p.id !== paneId);
  if (state.activePaneId === paneId) {
    state.activePaneId = state.panes[state.panes.length - 1].id;
  }
  renderWorkspace();
  saveUIState();
}

function setActivePaneId(id) {
  if (state.activePaneId === id) return;
  state.activePaneId = id;
  // Only toggle the CSS class — rebuilding the DOM would destroy textarea focus
  document.querySelectorAll('.pane').forEach(el => {
    el.classList.toggle('active', el.id === `pane-${id}`);
  });
  renderSidebar();
  renderStatusbar();
  saveUIState();
}

async function openChatInPane(chatId, paneId) {
  const pid = paneId || state.activePaneId;
  const pane = state.panes.find(p => p.id === pid);
  if (!pane) return;
  pane.chatId = chatId;
  if (chatId && !state.loadedChats[chatId]) {
    try {
      state.loadedChats[chatId] = await api.getChat(chatId);
    } catch (e) {
      notify(`Failed to load chat: ${e.message}`, 'err');
    }
  }
  state.activePaneId = pid;
  renderSidebar();
  renderWorkspace();
  saveUIState();
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function refreshChats() {
  state.chats = await api.getChats();
}

async function refreshMCPServers() {
  state.mcpServers = await api.getMCPServers();
  state.mcpTools = await api.getMCPTools();
}

async function refreshRagCollections() {
  state.ragCollections = await api.getRagCollections();
}

// ─── Connection Check ─────────────────────────────────────────────────────────

async function checkConnection() {
  try {
    const data = await api.getModels();
    state.models = data.models || [];
    state.connected = true;
  } catch {
    state.connected = false;
    state.models = [];
  }
  renderTitlebar();
  renderRightPanel();
}

// ─── Chat Sending / Streaming ─────────────────────────────────────────────────

async function sendMessage(paneId, content) {
  if (!content.trim()) return;
  const pane = state.panes.find(p => p.id === paneId);
  if (!pane) return;
  if (pane.streaming) { notify('Already streaming', 'warn'); return; }

  // If no chat open, create one
  if (!pane.chatId) {
    try {
      const chat = await api.createChat({ name: 'New Chat', projectId: null });
      pane.chatId = chat.id;
      state.loadedChats[chat.id] = chat;
      await refreshChats();
      renderSidebar();
    } catch (e) {
      notify(`Failed to create chat: ${e.message}`, 'err');
      return;
    }
  }

  // Route to arena if arena mode is active
  if (pane.arenaMode && pane.arenaConfig) {
    return sendArenaMessage(paneId, content);
  }

  const chatId = pane.chatId;
  if (!state.loadedChats[chatId]) {
    try {
      state.loadedChats[chatId] = await api.getChat(chatId);
    } catch (e) {
      notify(`Failed to load chat: ${e.message}`, 'err');
      return;
    }
  }

  // Build content with any attached file context
  let fullContent = content;
  if (pane.pendingFile?.text) {
    fullContent = `[Attached file: ${pane.pendingFile.name}]\n\`\`\`\n${pane.pendingFile.text}\n\`\`\`\n\n${content}`;
    pane.pendingFile = null;
  }

  // Grab pending images and clear them
  const pendingImages = [...(pane.pendingImages || [])];
  pane.pendingImages = [];

  // Add user message to local cache for immediate display
  const userMsg = { role: 'user', content: fullContent, timestamp: Date.now(), images: pendingImages.length > 0 ? pendingImages.map(i => i.dataUrl) : undefined };
  state.loadedChats[chatId].messages.push(userMsg);

  // Init streaming state
  pane.streaming = true;
  pane.streamText = '';
  pane.toolCalls = [];

  renderPane(pane);
  scrollPaneToBottom(paneId);

  // Build an assistant message placeholder
  const asstMsg = { role: 'assistant', content: '', timestamp: Date.now(), _streaming: true };
  state.loadedChats[chatId].messages.push(asstMsg);
  const asstMsgIdx = state.loadedChats[chatId].messages.length - 1;

  renderPane(pane);
  scrollPaneToBottom(paneId);

  const paneSettings = pane.model ? { ...state.settings, model: pane.model } : state.settings;
  const ctrl = await api.streamChat(
    chatId,
    fullContent,
    paneSettings,
    { useMCPTools: state.settings.useMCPTools, images: pendingImages.map(i => i.dataUrl.split(',')[1]) },
    {
      onDelta(text) {
        pane.streamText += text;
        asstMsg.content = pane.streamText;
        const msgEl = document.querySelector(`#pane-${paneId} .msg-streaming`);
        if (msgEl) {
          msgEl.textContent = pane.streamText;
        } else {
          renderPane(pane);
        }
        scrollPaneToBottom(paneId);
      },
      onToolCallStart(data) {
        pane.toolCalls.push({ id: data.id, name: data.name, args: data.args, result: null, status: 'running' });
        renderPane(pane);
        scrollPaneToBottom(paneId);
      },
      onToolCallResult(data) {
        const tc = pane.toolCalls.find(t => t.id === data.id);
        if (tc) { tc.result = data.result; tc.status = 'done'; }
        renderPane(pane);
        scrollPaneToBottom(paneId);
      },
      onRagStatus(data) {
        const statusEl = document.querySelector(`#pane-${paneId} .msg-streaming`);
        if (data.status === 'searching') {
          if (statusEl) statusEl.textContent = '░ Searching knowledge base...';
        } else if (data.status === 'found') {
          if (statusEl) statusEl.textContent = `░ Found ${data.count} relevant chunks (score: ${data.topScore?.toFixed(2)})`;
          // Store RAG chunks for display
          pane.ragChunks = data.chunks || [];
        } else if (data.status === 'no_results') {
          if (statusEl) statusEl.textContent = '░ No relevant knowledge found';
        } else if (data.status === 'error') {
          if (statusEl) statusEl.textContent = `░ RAG error: ${data.message}`;
        }
      },
      async onDone(data) {
        pane.streaming = false;
        pane.controller = null;
        pane.ragChunks = null;

        // Reload from server — _perf and _ragChunks are now persisted on messages
        try {
          state.loadedChats[chatId] = await api.getChat(chatId);
        } catch {}

        // Update chat metadata in list
        await refreshChats();
        renderSidebar();
        renderPane(pane);
        scrollPaneToBottom(paneId);
        saveUIState();

        // Refocus textarea after streaming completes
        setTimeout(() => {
          const ta = document.querySelector(`#pane-${paneId} .pane-textarea`);
          if (ta) ta.focus();
        }, 50);
      },
      onError(msg) {
        pane.streaming = false;
        pane.controller = null;
        asstMsg._streaming = false;
        asstMsg._error = true;
        asstMsg.content = `Error: ${msg}`;
        renderPane(pane);
        notify(msg, 'err');
      },
    }
  );

  pane.controller = ctrl;
  renderPane(pane);
}

async function sendArenaMessage(paneId, content) {
  const pane = state.panes.find(p => p.id === paneId);
  if (!pane?.arenaConfig) return;
  const cfg = pane.arenaConfig;
  const chatId = pane.chatId;

  // Add user message
  const userMsg = { role: 'user', content, timestamp: Date.now() };
  state.loadedChats[chatId].messages.push(userMsg);

  pane.streaming = true;
  renderPane(pane);
  scrollPaneToBottom(paneId);

  // Build arena request body
  const modeConfig = {};
  if (cfg.mode === 'sequential') modeConfig.maxTurns = cfg.seqTurns;
  if (cfg.mode === 'judge') modeConfig.judgeCriteria = cfg.judgeCriteria || '';
  if (cfg.mode === 'debate') {
    modeConfig.rounds = cfg.debateRounds;
    modeConfig.debatePositions = cfg.debatePositions;
  }
  if (cfg.mode === 'refinement') modeConfig.cycles = cfg.refinementCycles;
  if (cfg.mode === 'orchestrated') modeConfig.maxSteps = cfg.orchMaxSteps;

  const agents = cfg.agents.map((a, i) => ({
    name: `Agent ${i + 1}`,
    model: a.model,
    role: a.role,
    systemPrompt: a.systemPrompt || '',
    enableTools: a.enableTools || false,
  }));

  // If judge mode, set judge agent name
  if (cfg.mode === 'judge') {
    const judgeAgent = agents.find(a => a.role === 'judge');
    if (judgeAgent) modeConfig.judgeAgentName = judgeAgent.name;
  }

  const body = {
    prompt: content,
    mode: cfg.mode,
    agents,
    settings: state.settings,
    modeConfig,
  };

  // Arena results accumulate into a single assistant message with formatted content
  let arenaContent = `**⚔Arena: ${cfg.mode}** (${agents.length} agents)\n\n`;
  const asstMsg = { role: 'assistant', content: arenaContent, timestamp: Date.now(), _streaming: true, _arena: true };
  state.loadedChats[chatId].messages.push(asstMsg);

  renderPane(pane);
  scrollPaneToBottom(paneId);

  try {
    const ctrl = new AbortController();
    pane.controller = ctrl;
    const res = await fetch('/api/arena/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) {
        if (e.name !== 'AbortError') notify(e.message, 'err');
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = 'message', dataStr = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr = line.slice(6);
        }
        if (!dataStr) continue;
        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        // Append arena events as formatted content
        if (eventType === 'agent_start') {
          arenaContent += `---\n### ${data.agentName} (${data.model})\n`;
        } else if (eventType === 'delta') {
          arenaContent += data.text || '';
        } else if (eventType === 'agent_done') {
          arenaContent += '\n\n';
        } else if (eventType === 'round_start') {
          arenaContent += `\n---\n**Round ${data.round}**\n\n`;
        } else if (eventType === 'judge_result') {
          arenaContent += `---\n### Judge Verdict\n`;
          if (data.scores) {
            arenaContent += Object.entries(data.scores).map(([name, score]) => `- **${name}**: ${score}/10`).join('\n') + '\n';
          }
          if (data.reasoning) arenaContent += `\n${data.reasoning}\n`;
          if (data.winner) arenaContent += `\n**Winner: ${data.winner}**\n`;
        } else if (eventType === 'refinement_cycle_done') {
          arenaContent += `\n*--- Cycle ${data.cycle} complete ---*\n\n`;
        } else if (eventType === 'refinement_final') {
          arenaContent += `\n---\n### Final (refined)\n`;
        } else if (eventType === 'orchestrator_thinking' || eventType === 'orchestrator_delta') {
          arenaContent += data.text || '';
        } else if (eventType === 'orchestrator_command') {
          arenaContent += `\n*Orchestrator assigned: ${data.workerName} — ${data.task}*\n\n`;
        } else if (eventType === 'worker_start') {
          arenaContent += `**${data.workerName}** (${data.model}):\n`;
        } else if (eventType === 'worker_delta') {
          arenaContent += data.text || '';
        } else if (eventType === 'worker_done') {
          arenaContent += '\n\n';
        } else if (eventType === 'orchestrator_final') {
          arenaContent += `\n---\n### Orchestrator Summary\n`;
        } else if (eventType === 'done') {
          // done
        } else if (eventType === 'error') {
          arenaContent += `\n**Error:** ${data.message}\n`;
        }

        asstMsg.content = arenaContent;
        const msgEl = document.querySelector(`#pane-${paneId} .msg-streaming`);
        if (msgEl) msgEl.textContent = arenaContent;
        scrollPaneToBottom(paneId);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') notify(e.message, 'err');
  }

  pane.streaming = false;
  pane.controller = null;
  asstMsg._streaming = false;
  asstMsg.content = arenaContent;

  // Save arena results to chat
  try {
    await api.updateChat(chatId, { messages: state.loadedChats[chatId].messages });
  } catch {}

  await refreshChats();
  renderSidebar();
  renderPane(pane);
  scrollPaneToBottom(paneId);
}

function scrollPaneToBottom(paneId) {
  const el = document.querySelector(`#pane-${paneId} .pane-messages`);
  if (el) el.scrollTop = el.scrollHeight;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderAll() {
  renderTitlebar();
  renderSidebar();
  renderWorkspace();
  renderRightPanel();
  renderStatusbar();
}

function renderTitlebar() {
  const bar = document.getElementById('titlebar');
  const model = state.settings.model || 'no model';
  bar.innerHTML = `
    <span class="titlebar-logo">OLLAMA // TUI</span>
    <span class="titlebar-sep">│</span>
    <span class="conn-dot ${state.connected ? 'ok' : 'err'}" title="${state.connected ? 'Connected' : 'Disconnected'}"></span>
    <span class="titlebar-model">${esc(model)}</span>
    <span class="titlebar-spacer"></span>
    <button class="titlebar-btn${state.panes.find(p => p.id === state.activePaneId)?.arenaMode ? ' active' : ''}" id="btn-arena">⚔Arena</button>
    <button class="titlebar-btn" id="btn-full-settings">⚙ Settings</button>
    <button class="titlebar-btn" id="btn-new-project">+ Project</button>
    <button class="titlebar-btn" id="btn-models">Models</button>
    <button class="titlebar-btn" id="btn-reconnect">${state.connected ? 'Connected' : 'Connect'}</button>
  `;
  bar.querySelector('#btn-arena').onclick = () => {
    const pane = state.panes.find(p => p.id === state.activePaneId);
    if (!pane) return;
    pane.arenaMode = !pane.arenaMode;
    if (pane.arenaMode) {
      // Initialize arena config if not set
      if (!pane.arenaConfig) {
        pane.arenaConfig = {
          mode: 'parallel',
          agents: [
            { model: state.settings.model, role: 'worker', systemPrompt: '', enableTools: false },
            { model: state.settings.model, role: 'worker', systemPrompt: '', enableTools: false },
          ],
          judeCriteria: '',
          debateRounds: 2,
          debatePositions: ['For', 'Against'],
          refinementCycles: 2,
          orchMaxSteps: 8,
          seqTurns: 3,
        };
      }
      state.rightTab = 'arena';
    } else {
      if (state.rightTab === 'arena') state.rightTab = 'chat';
    }
    renderAll();
  };
  bar.querySelector('#btn-full-settings').onclick = () => openModal('full-settings');
  bar.querySelector('#btn-new-project').onclick = () => openModal('new-project');
  bar.querySelector('#btn-models').onclick = () => openModal('model-manager');
  bar.querySelector('#btn-reconnect').onclick = () => { checkConnection(); };
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  const activeChatIds = new Set(state.panes.map(p => p.chatId).filter(Boolean));

  const chatItemHtml = (c) => {
    const msgCount = c.messages?.length || c.messageCount || 0;
    const lastTime = c.updatedAt || c.createdAt || '';
    return `
      <div class="sidebar-chat-item ${activeChatIds.has(c.id) ? 'active' : ''} ${c.pinned ? 'pinned' : ''}"
           data-open-chat="${c.id}"
           data-chat-id="${c.id}"
           title="${esc(c.name)}"
           draggable="true">
        ${c.starred ? '<span class="chat-star">★</span>' : ''}
        <span class="sidebar-chat-name">${esc(c.name)}</span>
        ${c.pinned ? '<span class="chat-pin-dot" title="Pinned"></span>' : ''}
        <div class="chat-meta">
          ${msgCount > 0 ? `<span>${msgCount} msg${msgCount !== 1 ? 's' : ''}</span>` : ''}
          ${lastTime ? `<span>${relativeTime(lastTime)}</span>` : ''}
        </div>
      </div>
    `;
  };

  let html = `
    <div class="sidebar-header">
      <span>Chats</span>
      <div class="sidebar-header-btns">
        <button class="icon-btn" id="sb-import-chat" title="Import chat (JSON)">⬆</button>
        <button class="icon-btn" id="sb-new-chat" title="New Chat (Ctrl+N)">+</button>
      </div>
    </div>
    <div class="sidebar-tree" id="sidebar-tree">
  `;

  // Starred chats section (across all projects/ungrouped)
  const starredChats = state.chats.filter(c => c.starred).sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });
  if (starredChats.length > 0) {
    html += `<div class="sidebar-section-label">★ Starred</div>`;
    for (const c of starredChats) {
      html += chatItemHtml(c);
    }
    html += `<div class="sidebar-section-divider"></div>`;
  }

  // Projects with their chats
  for (const proj of state.projects) {
    const isExpanded = state.expandedProjects.has(proj.id);
    const projChats = state.chats.filter(c => c.projectId === proj.id).sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return 0;
    });
    html += `
      <div class="project-item ${isExpanded ? 'expanded' : ''}" data-project-id="${proj.id}">
        <div class="project-header" data-toggle-project="${proj.id}">
          <span class="project-chevron">▶</span>
          <span class="project-color-dot" style="background:${proj.color || '#00ff88'}"></span>
          <span class="project-name">${esc(proj.name)}</span>
          <button class="proj-new-chat-btn icon-btn" data-new-chat-in-project="${proj.id}" title="New chat in project">+</button>
        </div>
        <div class="project-chats">
          ${projChats.length === 0 ? `<div class="sidebar-chat-item text-dim" style="font-size:10px;padding-left:8px">empty</div>` : ''}
          ${projChats.map(c => chatItemHtml(c)).join('')}
        </div>
      </div>
    `;
  }

  // Ungrouped chats
  const ungrouped = state.chats.filter(c => !c.projectId).sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });
  if (ungrouped.length > 0 || state.projects.length === 0) {
    if (state.projects.length > 0) html += `<div class="sidebar-section-label">Ungrouped</div>`;
    for (const c of ungrouped) {
      html += chatItemHtml(c);
    }
  }

  html += `</div>`;
  sb.innerHTML = html;

  // Events
  sb.querySelector('#sb-new-chat').onclick = () => newChatInActivePane();
  sb.querySelector('#sb-import-chat').onclick = () => importChat();

  sb.querySelectorAll('[data-toggle-project]').forEach(el => {
    el.addEventListener('click', e => {
      // Don't toggle if clicking the + new chat button inside the header
      if (e.target.closest('[data-new-chat-in-project]')) return;
      e.stopPropagation();
      const id = el.dataset.toggleProject;
      if (state.expandedProjects.has(id)) state.expandedProjects.delete(id);
      else state.expandedProjects.add(id);
      renderSidebar();
      saveUIState();
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.toggleProject;
      openProjectContextMenu(e, id);
    });
  });

  sb.querySelectorAll('[data-open-chat]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openChatInPane(el.dataset.openChat);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(e, el.dataset.chatId);
    });
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', el.dataset.chatId);
    });
  });

  sb.querySelectorAll('[data-new-chat-in-project]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      await newChatInActivePane(el.dataset.newChatInProject);
    });
  });
}

function renderWorkspace() {
  const container = document.getElementById('pane-container');
  container.innerHTML = '';
  state.panes.forEach((pane, i) => {
    if (i > 0) {
      const div = document.createElement('div');
      div.className = 'pane-divider';
      div.dataset.dividerBefore = pane.id;
      container.appendChild(div);
    }
    const paneEl = createPaneElement(pane);
    container.appendChild(paneEl);
  });
  setupPaneDividerDrag();
}

function renderPane(pane) {
  const existing = document.getElementById(`pane-${pane.id}`);
  if (!existing) { renderWorkspace(); return; }
  const newEl = createPaneElement(pane);
  existing.replaceWith(newEl);
}

function createPaneElement(pane) {
  const isActive = pane.id === state.activePaneId;
  const chat = pane.chatId ? state.loadedChats[pane.chatId] : null;
  const messages = chat?.messages || [];

  const el = document.createElement('div');
  el.className = `pane${isActive ? ' active' : ''}`;
  el.id = `pane-${pane.id}`;
  el.tabIndex = 0;
  el.addEventListener('focus', () => setActivePaneId(pane.id));
  el.addEventListener('click', () => setActivePaneId(pane.id));

  // Title bar
  const tbEl = document.createElement('div');
  tbEl.className = 'pane-titlebar';

  // Chat selector
  const sel = document.createElement('select');
  sel.className = 'pane-chat-select';
  const noOpt = document.createElement('option');
  noOpt.value = '';
  noOpt.textContent = '── select chat ──';
  sel.appendChild(noOpt);
  for (const c of state.chats) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === pane.chatId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    openChatInPane(sel.value || null, pane.id);
  });
  tbEl.appendChild(sel);

  // Model badge (clickable)
  const badge = document.createElement('span');
  badge.className = 'pane-model-badge';
  const paneModel = pane.model || state.settings.model || 'no model';
  badge.title = 'Click to change model for this pane';
  badge.textContent = paneModel.split(':')[0];
  badge.style.cursor = 'pointer';
  badge.onclick = (e) => {
    e.stopPropagation();
    openPaneModelPicker(badge, pane);
  };
  tbEl.appendChild(badge);

  // Context usage bar
  const ctxBar = document.createElement('div');
  ctxBar.className = 'pane-ctx-bar';
  ctxBar.title = 'Context usage';
  if (chat && chat.messages.length > 0) {
    const ctxLimit = state.settings.ctxLimit || 20;
    const msgCount = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    const pct = Math.min(100, Math.round((msgCount / ctxLimit) * 100));
    const color = pct > 80 ? 'var(--err)' : pct > 60 ? 'var(--warn)' : 'var(--accent)';
    ctxBar.innerHTML = `<div class="pane-ctx-fill" style="width:${pct}%;background:${color}"></div>`;
    ctxBar.title = `${msgCount}/${ctxLimit} messages in context (${pct}%)`;
  }
  tbEl.appendChild(ctxBar);

  // New chat btn
  const newBtn = document.createElement('button');
  newBtn.className = 'pane-btn';
  newBtn.textContent = '+ new';
  newBtn.title = 'New chat (Ctrl+N)';
  newBtn.onclick = e => { e.stopPropagation(); newChatInPane(pane.id); };
  tbEl.appendChild(newBtn);

  // Split btn
  if (state.panes.length < 4) {
    const splitBtn = document.createElement('button');
    splitBtn.className = 'pane-btn';
    splitBtn.textContent = '⊞ split';
    splitBtn.title = 'Split pane (Ctrl+\\)';
    splitBtn.onclick = e => { e.stopPropagation(); addPane(); };
    tbEl.appendChild(splitBtn);
  }

  // Stream stop / close
  if (pane.streaming) {
    const stopBtn = document.createElement('button');
    stopBtn.className = 'pane-btn streaming';
    stopBtn.textContent = '■ stop';
    stopBtn.onclick = e => { e.stopPropagation(); stopStreaming(pane.id); };
    tbEl.appendChild(stopBtn);
  }

  if (state.panes.length > 1) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-btn close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close pane (Ctrl+W)';
    closeBtn.onclick = e => { e.stopPropagation(); removePane(pane.id); };
    tbEl.appendChild(closeBtn);
  }

  el.appendChild(tbEl);

  // Search bar (hidden by default)
  const searchBar = document.createElement('div');
  searchBar.className = 'pane-search-bar';
  searchBar.id = `pane-search-${pane.id}`;
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input class="pane-search-input" placeholder="Search messages..." autocomplete="off">
    <span class="pane-search-count"></span>
    <button class="pane-btn" id="pane-search-close-${pane.id}">✕</button>
  `;
  el.appendChild(searchBar);

  // Messages
  const msgsEl = document.createElement('div');
  msgsEl.className = 'pane-messages';

  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty';
    empty.innerHTML = `
      <div class="pane-empty-logo">OLLAMA</div>
      <div>No messages yet</div>
      <div style="font-size:10px;color:var(--text-dim)">Type a message to start</div>
    `;
    msgsEl.appendChild(empty);
  } else {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip tool result messages — they're rendered with their parent assistant message
      if (msg.role === 'tool') continue;

      const isLastAsst = msg.role === 'assistant' && i === messages.length - 1;
      const isStreaming = pane.streaming && isLastAsst && msg._streaming;

      // Build tool calls: from saved data or live streaming
      let tcList = [];
      if (isStreaming && pane.toolCalls?.length > 0) {
        tcList = pane.toolCalls;
      } else if (msg.tool_calls?.length > 0) {
        // Reconstruct tool call display from saved messages
        tcList = msg.tool_calls.map(tc => {
          const toolResult = messages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
          return {
            id: tc.id,
            name: tc.name,
            args: tc.args || {},
            result: toolResult?.content || null,
            status: toolResult ? 'done' : 'unknown',
          };
        });
      }

      const msgEl = createMessageEl(msg, isStreaming, tcList);
      msgsEl.appendChild(msgEl);
    }
  }

  el.appendChild(msgsEl);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'pane-input-area';

  const row = document.createElement('div');
  row.className = 'pane-input-row';

  const ta = document.createElement('textarea');
  ta.className = 'pane-textarea';
  ta.placeholder = pane.arenaMode ? 'Arena prompt... (Enter to send)' : 'Send a message... (Enter to send, Shift+Enter for newline)';
  ta.rows = 1;
  ta.disabled = pane.streaming;

  // Auto-resize
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    const lines = Math.min(6, Math.max(1, ta.value.split('\n').length));
    ta.style.height = (lines * 20 + 4) + 'px';
  });

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = ta.value.trim();
      if (val) {
        ta.value = '';
        ta.style.height = 'auto';
        sendMessage(pane.id, val);
      }
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = pane.streaming ? '...' : '▶ Send';
  sendBtn.disabled = pane.streaming;
  sendBtn.onclick = () => {
    const val = ta.value.trim();
    if (val) {
      ta.value = '';
      ta.style.height = 'auto';
      sendMessage(pane.id, val);
    }
  };

  // File attach button
  const attachBtn = document.createElement('button');
  attachBtn.className = 'pane-btn attach-btn';
  attachBtn.textContent = '⊕';
  attachBtn.title = 'Attach image or file';
  attachBtn.type = 'button';
  attachBtn.onclick = (e) => {
    e.stopPropagation();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,.pdf,.txt,.md,.csv,.json,.js,.py,.ts,.html,.css';
    fileInput.onchange = () => handleFileAttach(pane, fileInput.files[0]);
    fileInput.click();
  };
  row.appendChild(attachBtn);

  row.appendChild(ta);
  row.appendChild(sendBtn);

  // Attachment previews
  const attachPreview = document.createElement('div');
  attachPreview.className = 'attach-preview';
  attachPreview.id = `attach-preview-${pane.id}`;
  if (pane.pendingImages?.length > 0 || pane.pendingFile) {
    (pane.pendingImages || []).forEach((img, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'attach-thumb';
      thumb.innerHTML = `<img src="${img.dataUrl}" style="max-height:40px;max-width:60px;object-fit:cover"><button class="attach-remove" data-img-idx="${idx}">✕</button>`;
      attachPreview.appendChild(thumb);
    });
    if (pane.pendingFile) {
      const fileThumb = document.createElement('div');
      fileThumb.className = 'attach-thumb file-thumb';
      fileThumb.innerHTML = `<span>📄 ${esc(pane.pendingFile.name)}</span><button class="attach-remove" data-file="1">✕</button>`;
      attachPreview.appendChild(fileThumb);
    }
  }
  // Input toolbar with tool toggles
  const toolbar = document.createElement('div');
  toolbar.className = 'input-toolbar';

  if (pane.arenaMode) {
    const arenaBadge = document.createElement('button');
    arenaBadge.className = 'input-tool-btn active';
    arenaBadge.style.cssText = 'background:var(--warn);border-color:var(--warn);color:var(--bg)';
    arenaBadge.textContent = `⚔Arena: ${pane.arenaConfig?.mode || 'parallel'}`;
    arenaBadge.title = 'Arena mode active — click to configure';
    arenaBadge.onclick = () => { state.rightTab = 'arena'; renderRightPanel(); };
    toolbar.appendChild(arenaBadge);
  }

  const webSearchBtn = document.createElement('button');
  webSearchBtn.className = `input-tool-btn${state.settings.webSearch ? ' active' : ''}`;
  webSearchBtn.textContent = '⊕ Search';
  webSearchBtn.title = 'Toggle web search';
  webSearchBtn.onclick = () => {
    state.settings.webSearch = !state.settings.webSearch;
    api.updateSettings({ webSearch: state.settings.webSearch });
    webSearchBtn.classList.toggle('active', state.settings.webSearch);
    renderRightPanel();
  };
  toolbar.appendChild(webSearchBtn);

  if (state.mcpTools.length > 0) {
    const mcpBtn = document.createElement('button');
    mcpBtn.className = `input-tool-btn${state.settings.useMCPTools !== false ? ' active' : ''}`;
    mcpBtn.textContent = `⊕ MCP (${state.mcpTools.length})`;
    mcpBtn.title = 'Toggle MCP tools';
    mcpBtn.onclick = () => {
      const newVal = state.settings.useMCPTools === false ? true : false;
      state.settings.useMCPTools = newVal;
      api.updateSettings({ useMCPTools: newVal });
      mcpBtn.classList.toggle('active', newVal);
      renderRightPanel();
    };
    toolbar.appendChild(mcpBtn);
  }

  if (state.ragCollections.length > 0) {
    const ragOn = state.settings.ragEnabled && state.settings.ragCollection;
    const ragCol = ragOn ? state.ragCollections.find(c => c.id === state.settings.ragCollection) : null;
    const ragBtn = document.createElement('button');
    ragBtn.className = `input-tool-btn${ragOn ? ' active' : ''}`;
    ragBtn.textContent = ragOn ? `◈ ${ragCol ? ragCol.name : 'RAG'}` : '◈ RAG';
    ragBtn.title = ragOn ? 'RAG active — click to disable' : 'Enable RAG — select a collection in Knowledge tab';
    ragBtn.onclick = () => {
      if (ragOn) {
        state.settings.ragEnabled = false;
        api.updateSettings({ ragEnabled: false });
      } else if (state.settings.ragCollection) {
        state.settings.ragEnabled = true;
        api.updateSettings({ ragEnabled: true });
      } else {
        // No collection selected — switch to knowledge tab
        state.rightTab = 'knowledge';
        renderRightPanel();
        notify('Select a collection first', 'warn');
        return;
      }
      renderPane(pane);
      renderRightPanel();
    };
    toolbar.appendChild(ragBtn);
  }

  // Append in correct order: preview, toolbar, input row
  inputArea.appendChild(attachPreview);
  inputArea.appendChild(toolbar);
  inputArea.appendChild(row);

  // Remove attachment handlers
  attachPreview.querySelectorAll('.attach-remove').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.dataset.imgIdx !== undefined) {
        pane.pendingImages?.splice(parseInt(btn.dataset.imgIdx), 1);
      } else if (btn.dataset.file) {
        pane.pendingFile = null;
      }
      renderPane(pane);
    };
  });

  el.appendChild(inputArea);

  // Drag & drop handlers
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    files.forEach(f => handleFileAttach(pane, f));
  });

  // Paste handler for images
  ta.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      handleFileAttach(pane, imageItem.getAsFile());
    }
  });

  return el;
}

// Handle file/image attachment to a pane
async function handleFileAttach(pane, file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  if (isImage) {
    const reader = new FileReader();
    reader.onload = () => {
      if (!pane.pendingImages) pane.pendingImages = [];
      pane.pendingImages.push({ dataUrl: reader.result, mimeType: file.type, name: file.name });
      renderPane(pane);
    };
    reader.readAsDataURL(file);
  } else {
    // Text/PDF file - upload for text extraction
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        notify(`Uploading ${file.name}...`, 'ok');
        const base64 = reader.result.split(',')[1];
        const result = await api.uploadFile(file.name, base64, file.type);
        pane.pendingFile = { name: file.name, text: result.text, charCount: result.charCount };
        renderPane(pane);
        notify(`Attached: ${file.name} (${result.charCount} chars)`, 'ok');
      } catch (e) {
        notify(`Upload failed: ${e.message}`, 'err');
      }
    };
    reader.readAsDataURL(file);
  }
}

// Split <think>...</think> from content (for DeepSeek-R1, QwQ, etc.)
function parseThinking(content) {
  if (!content) return { thinking: null, rest: '' };
  // Complete think block
  const full = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (full) return { thinking: full[1].trim(), rest: content.slice(full[0].length) };
  // Streaming — think block still open
  const open = content.match(/^<think>([\s\S]*)/);
  if (open) return { thinking: open[1].trim(), rest: '', open: true };
  return { thinking: null, rest: content };
}

// ─── Markdown Rendering ───────────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return esc(text).replace(/\n/g, '<br>');
  try {
    const html = marked.parse(text, { breaks: true, gfm: true });
    if (typeof hljs !== 'undefined') {
      // highlight.js is available - it auto-highlights via marked renderer
    }
    return html;
  } catch {
    return esc(text).replace(/\n/g, '<br>');
  }
}

function configureMarked() {
  if (typeof marked === 'undefined') return;
  try {
    const renderer = {
      code(src, lang) {
        // marked v11+ may pass token object or separate args depending on version
        let code = src, language = lang;
        if (typeof src === 'object' && src !== null) {
          code = src.text || src.code || '';
          language = src.lang || '';
        }
        code = code || '';
        language = language || '';
        const validLang = language && typeof hljs !== 'undefined' && hljs.getLanguage(language) ? language : null;
        const highlighted = validLang
          ? hljs.highlight(code, { language: validLang }).value
          : (typeof hljs !== 'undefined' ? hljs.highlightAuto(code).value : esc(code));
        return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${esc(language || 'code')}</span><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block-wrapper').querySelector('code').textContent).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘ copy',1500)})">⎘ copy</button></div><pre><code class="hljs ${esc(language || '')}">${highlighted}</code></pre></div>`;
      }
    };
    marked.use({ renderer, breaks: true, gfm: true });
  } catch (e) {
    console.warn('Failed to configure marked:', e);
  }
}

function createMessageEl(msg, isStreaming, toolCalls) {
  const el = document.createElement('div');
  let roleClass = msg.role;
  if (msg._error) roleClass = 'error';
  el.className = `message ${roleClass}`;

  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span class="msg-role ${roleClass}">${msg.role.toUpperCase()}</span><span class="msg-time">${ts}</span>`;
  el.appendChild(header);

  // Tool calls before the content
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      el.appendChild(createToolCallEl(tc));
    }
  }

  // Parse <think> blocks (reasoning models)
  const { thinking, rest, open: thinkOpen } = parseThinking(msg.content || '');

  if (thinking !== null) {
    const thinkEl = document.createElement('div');
    thinkEl.className = 'think-block';
    const thinkHeader = document.createElement('div');
    thinkHeader.className = 'think-header';
    thinkHeader.innerHTML = `<span class="think-icon">◈</span><span class="think-label">Thinking${thinkOpen ? '...' : ''}</span><span class="think-chevron">▼</span>`;
    const thinkBody = document.createElement('pre');
    thinkBody.className = 'think-body';
    thinkBody.textContent = thinking;
    thinkHeader.onclick = () => thinkEl.classList.toggle('collapsed');
    thinkEl.appendChild(thinkHeader);
    thinkEl.appendChild(thinkBody);
    thinkEl.classList.add('collapsed');
    el.appendChild(thinkEl);
  }

  const body = document.createElement('div');
  body.className = `msg-body${isStreaming ? ' streaming-cursor msg-streaming' : ''}`;
  if (isStreaming) {
    // During streaming: plain text for performance
    body.textContent = rest;
  } else if (rest && msg.role === 'assistant' && !msg._error) {
    // Render markdown for completed assistant messages
    body.innerHTML = renderMarkdown(rest);
  } else {
    body.textContent = rest;
  }
  el.appendChild(body);

  // RAG context display (collapsible)
  if (msg._ragChunks?.length > 0 && !isStreaming) {
    const ragEl = document.createElement('div');
    ragEl.className = 'rag-context-block';
    ragEl.innerHTML = `
      <div class="rag-context-header">
        <span class="rag-context-icon">◈</span>
        <span class="rag-context-label">RAG Context (${msg._ragChunks.length} chunks)</span>
        <span class="rag-context-chevron">▼</span>
      </div>
      <div class="rag-context-body">
        ${msg._ragChunks.map(c => `
          <div class="rag-chunk">
            <div class="rag-chunk-meta">${esc(c.docTitle)} — score: ${c.score.toFixed(3)}</div>
            <div class="rag-chunk-text">${esc(c.text)}${c.text.length >= 200 ? '...' : ''}</div>
          </div>
        `).join('')}
      </div>
    `;
    ragEl.querySelector('.rag-context-header').onclick = () => ragEl.classList.toggle('expanded');
    el.appendChild(ragEl);
  }

  // Performance stats
  if (msg._perf && !isStreaming) {
    const p = msg._perf;
    const perfEl = document.createElement('div');
    perfEl.className = 'msg-perf';
    const parts = [];
    if (p.tokPerSec) parts.push(`${p.tokPerSec} tok/s`);
    if (p.tokens) parts.push(`${p.tokens} tokens`);
    if (p.promptTokens) parts.push(`${p.promptTokens} prompt`);
    if (p.totalMs) parts.push(`${(p.totalMs / 1000).toFixed(1)}s`);
    perfEl.textContent = parts.join(' · ');
    el.appendChild(perfEl);
  }

  // Message action buttons (not shown during streaming or for tool/system messages)
  if (!isStreaming && msg.role !== 'tool' && msg.content) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy';
    copyBtn.textContent = '⎘';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(msg.content || '').then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
      });
    };
    actions.appendChild(copyBtn);

    if (msg.role === 'user') {
      // Edit button for user messages
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.title = 'Edit and resend';
      editBtn.textContent = '✎';
      editBtn.onclick = () => {
        const paneEl = el.closest('.pane');
        if (!paneEl) return;
        const paneId = paneEl.id.replace('pane-', '');
        const pane = state.panes.find(p => p.id === paneId);
        if (!pane?.chatId) return;
        const chat = state.loadedChats[pane.chatId];
        if (!chat) return;
        const msgIdx = chat.messages.indexOf(msg);
        if (msgIdx === -1) return;
        editMessageFromIndex(pane, chat, msgIdx, msg.content);
      };
      actions.appendChild(editBtn);
    }

    if (msg.role === 'assistant') {
      // Regenerate button for assistant messages
      const regenBtn = document.createElement('button');
      regenBtn.className = 'msg-action-btn';
      regenBtn.title = 'Regenerate';
      regenBtn.textContent = '↺';
      regenBtn.onclick = () => {
        const paneEl = el.closest('.pane');
        if (!paneEl) return;
        const paneId = paneEl.id.replace('pane-', '');
        const pane = state.panes.find(p => p.id === paneId);
        if (!pane?.chatId) return;
        const chat = state.loadedChats[pane.chatId];
        if (!chat) return;
        regenerateLastResponse(pane, chat);
      };
      actions.appendChild(regenBtn);

      // Branch button
      const branchBtn = document.createElement('button');
      branchBtn.className = 'msg-action-btn';
      branchBtn.title = 'Branch from here';
      branchBtn.textContent = '⑂';
      branchBtn.onclick = () => {
        const paneEl = el.closest('.pane');
        if (!paneEl) return;
        const paneId = paneEl.id.replace('pane-', '');
        const pane = state.panes.find(p => p.id === paneId);
        if (!pane?.chatId) return;
        const chat = state.loadedChats[pane.chatId];
        if (!chat) return;
        const msgIdx = chat.messages.indexOf(msg);
        if (msgIdx === -1) return;
        branchFromMessage(pane, chat, msgIdx);
      };
      actions.appendChild(branchBtn);

      // Thumbs feedback
      const thumbsUp = document.createElement('button');
      thumbsUp.className = `msg-action-btn${msg.feedback === 'up' ? ' active' : ''}`;
      thumbsUp.title = 'Good response';
      thumbsUp.textContent = '↑';
      thumbsUp.onclick = async () => {
        const paneEl = el.closest('.pane');
        if (!paneEl) return;
        const paneId = paneEl.id.replace('pane-', '');
        const pane = state.panes.find(p => p.id === paneId);
        if (!pane?.chatId) return;
        const chat = state.loadedChats[pane.chatId];
        if (!chat) return;
        const newFeedback = msg.feedback === 'up' ? null : 'up';
        msg.feedback = newFeedback;
        thumbsUp.className = `msg-action-btn${newFeedback === 'up' ? ' active' : ''}`;
        thumbsDown.className = 'msg-action-btn';
        try { await api.updateChat(pane.chatId, { messages: chat.messages }); } catch {}
      };

      const thumbsDown = document.createElement('button');
      thumbsDown.className = `msg-action-btn${msg.feedback === 'down' ? ' active' : ''}`;
      thumbsDown.title = 'Bad response';
      thumbsDown.textContent = '↓';
      thumbsDown.onclick = async () => {
        const paneEl = el.closest('.pane');
        if (!paneEl) return;
        const paneId = paneEl.id.replace('pane-', '');
        const pane = state.panes.find(p => p.id === paneId);
        if (!pane?.chatId) return;
        const chat = state.loadedChats[pane.chatId];
        if (!chat) return;
        const newFeedback = msg.feedback === 'down' ? null : 'down';
        msg.feedback = newFeedback;
        thumbsDown.className = `msg-action-btn${newFeedback === 'down' ? ' active' : ''}`;
        thumbsUp.className = 'msg-action-btn';
        try { await api.updateChat(pane.chatId, { messages: chat.messages }); } catch {}
      };

      actions.appendChild(thumbsUp);
      actions.appendChild(thumbsDown);
    }

    header.appendChild(actions);
  }

  return el;
}

async function editMessageFromIndex(pane, chat, msgIdx, originalContent) {
  if (pane.streaming) { notify('Cannot edit while streaming', 'warn'); return; }
  const ta = document.querySelector(`#pane-${pane.id} .pane-textarea`);
  if (!ta) return;
  ta.value = originalContent;
  ta.style.height = 'auto';
  ta.focus();

  // Truncate messages to just before this user message
  chat.messages = chat.messages.slice(0, msgIdx);
  try {
    await api.updateChat(chat.id, { messages: chat.messages });
  } catch (e) { notify(`Update failed: ${e.message}`, 'err'); return; }
  renderPane(pane);
}

async function regenerateLastResponse(pane, chat) {
  if (pane.streaming) { notify('Cannot regenerate while streaming', 'warn'); return; }
  // Remove the last assistant message
  const lastAsstIdx = [...chat.messages].reverse().findIndex(m => m.role === 'assistant');
  if (lastAsstIdx === -1) return;
  const realIdx = chat.messages.length - 1 - lastAsstIdx;
  const lastUserMsg = [...chat.messages].slice(0, realIdx).reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return;

  chat.messages = chat.messages.slice(0, realIdx);
  try {
    await api.updateChat(chat.id, { messages: chat.messages });
  } catch (e) { notify(`Update failed: ${e.message}`, 'err'); return; }
  renderPane(pane);
  sendMessage(pane.id, lastUserMsg.content);
}

async function branchFromMessage(pane, chat, msgIdx) {
  try {
    const branchMessages = chat.messages.slice(0, msgIdx + 1);
    const newChat = await api.createChat({
      name: `${chat.name} (branch)`,
      projectId: chat.projectId || null,
      messages: branchMessages,
    });
    state.loadedChats[newChat.id] = newChat;
    await refreshChats();
    pane.chatId = newChat.id;
    renderSidebar();
    renderPane(pane);
    notify('Branched to new chat', 'ok');
  } catch (e) { notify(`Branch failed: ${e.message}`, 'err'); }
}

function createToolCallEl(tc) {
  const el = document.createElement('div');
  el.className = `tool-call-block${tc.status === 'done' ? '' : ''}`;

  const statusLabel = tc.status === 'running' ? '⟳ running...' : tc.status === 'done' ? '✓ done' : '? no result';

  el.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-call-icon">░</span>
      <span class="tool-call-name">TOOL: ${esc(tc.name)}</span>
      <span class="tool-call-status">${statusLabel}</span>
      <span class="tool-call-chevron">▼</span>
    </div>
    <div class="tool-call-body">
      <span class="tool-call-section-label">├ args</span>
      <pre class="tool-call-code">${esc(JSON.stringify(tc.args, null, 2))}</pre>
      ${tc.result !== null ? `
        <span class="tool-call-section-label">└ result</span>
        <pre class="tool-call-code tool-call-result-text">${esc(String(tc.result))}</pre>
      ` : ''}
    </div>
  `;

  const header = el.querySelector('.tool-call-header');
  header.onclick = () => el.classList.toggle('expanded');

  return el;
}

function renderRightPanel() {
  const panel = document.getElementById('right-panel');

  const activePane = state.panes.find(p => p.id === state.activePaneId);
  const tabs = activePane?.arenaMode ? ['arena', 'chat', 'tools', 'knowledge'] : ['chat', 'tools', 'knowledge'];
  let tabsHtml = `<div class="right-tabs">`;
  for (const t of tabs) {
    tabsHtml += `<button class="tab${state.rightTab === t ? ' active' : ''}" data-tab="${t}">${t.toUpperCase()}</button>`;
  }
  tabsHtml += `</div>`;

  panel.innerHTML = tabsHtml + `<div class="right-content" id="right-content"></div>`;

  panel.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      state.rightTab = btn.dataset.tab;
      renderRightPanel();
      saveUIState();
    };
  });

  const content = document.getElementById('right-content');

  if (state.rightTab === 'arena') renderArenaTab(content);
  else if (state.rightTab === 'chat') renderChatTab(content);
  else if (state.rightTab === 'tools') renderToolsTab(content);
  else if (state.rightTab === 'knowledge') renderKnowledgeTab(content);
}

function renderArenaTab(content) {
  const pane = state.panes.find(p => p.id === state.activePaneId);
  if (!pane?.arenaConfig) return;
  const cfg = pane.arenaConfig;

  const roleOptions = {
    parallel: ['worker'],
    sequential: ['worker'],
    judge: ['worker', 'judge'],
    debate: ['debater', 'judge'],
    refinement: ['writer', 'critic'],
    orchestrated: ['orchestrator', 'worker'],
  };
  const roles = roleOptions[cfg.mode] || ['worker'];

  let html = `
    <div class="settings-group">
      <div class="settings-group-label">Arena Mode</div>
      <select class="settings-select" id="arena-mode">
        <option value="parallel" ${cfg.mode === 'parallel' ? 'selected' : ''}>Parallel</option>
        <option value="sequential" ${cfg.mode === 'sequential' ? 'selected' : ''}>Sequential</option>
        <option value="judge" ${cfg.mode === 'judge' ? 'selected' : ''}>Judge</option>
        <option value="debate" ${cfg.mode === 'debate' ? 'selected' : ''}>Debate</option>
        <option value="refinement" ${cfg.mode === 'refinement' ? 'selected' : ''}>Refinement</option>
        <option value="orchestrated" ${cfg.mode === 'orchestrated' ? 'selected' : ''}>Orchestrated</option>
      </select>
    </div>
  `;

  // Mode-specific config
  if (cfg.mode === 'judge') {
    html += `<div class="settings-group"><div class="settings-group-label">Judge Criteria</div>
      <textarea class="settings-input" id="arena-criteria" rows="2" style="resize:vertical;font-size:11px" placeholder="accuracy, clarity, completeness...">${esc(cfg.judgeCriteria || '')}</textarea></div>`;
  } else if (cfg.mode === 'debate') {
    html += `<div class="settings-group"><div class="settings-group-label">Debate</div>
      <div class="settings-row" style="display:flex;gap:4px">
        <input class="settings-input" id="arena-pos-0" value="${esc(cfg.debatePositions[0])}" style="flex:1" placeholder="Position A">
        <input class="settings-input" id="arena-pos-1" value="${esc(cfg.debatePositions[1])}" style="flex:1" placeholder="Position B">
      </div>
      <div class="settings-row"><div class="settings-label">Rounds <span id="lbl-debate-rounds">${cfg.debateRounds}</span></div>
        <input type="range" class="settings-range" id="arena-debate-rounds" min="1" max="6" value="${cfg.debateRounds}"></div></div>`;
  } else if (cfg.mode === 'refinement') {
    html += `<div class="settings-group"><div class="settings-group-label">Cycles <span id="lbl-ref-cycles">${cfg.refinementCycles}</span></div>
      <input type="range" class="settings-range" id="arena-ref-cycles" min="1" max="5" value="${cfg.refinementCycles}"></div>`;
  } else if (cfg.mode === 'orchestrated') {
    html += `<div class="settings-group"><div class="settings-group-label">Max Steps <span id="lbl-orch-steps">${cfg.orchMaxSteps}</span></div>
      <input type="range" class="settings-range" id="arena-orch-steps" min="2" max="20" value="${cfg.orchMaxSteps}"></div>`;
  } else if (cfg.mode === 'sequential') {
    html += `<div class="settings-group"><div class="settings-group-label">Turns <span id="lbl-seq-turns">${cfg.seqTurns}</span></div>
      <input type="range" class="settings-range" id="arena-seq-turns" min="1" max="20" value="${cfg.seqTurns}"></div>`;
  }

  // Agents
  html += `<div class="settings-group"><div class="settings-group-label" style="display:flex;justify-content:space-between;align-items:center">
    <span>Agents</span><button class="mcp-btn" id="btn-add-arena-agent">+ Add</button></div>`;
  cfg.agents.forEach((a, i) => {
    html += `
      <div style="background:var(--bg2);padding:6px;border-radius:4px;margin-bottom:4px">
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <select class="settings-select" data-agent-model="${i}" style="flex:1;font-size:10px">
            ${state.models.map(m => `<option value="${esc(m.name)}" ${m.name === a.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
          <select class="settings-select" data-agent-role="${i}" style="width:90px;font-size:10px">
            ${roles.map(r => `<option value="${r}" ${r === a.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          ${cfg.agents.length > 2 ? `<button class="mcp-btn danger" data-del-agent="${i}" style="font-size:10px;padding:2px 4px">✕</button>` : ''}
        </div>
        ${cfg.mode === 'orchestrated' && a.role === 'worker' ? `
          <label style="font-size:10px;color:var(--text-dim);display:flex;align-items:center;gap:4px">
            <input type="checkbox" data-agent-tools="${i}" ${a.enableTools ? 'checked' : ''}> Enable tools
          </label>
        ` : ''}
      </div>
    `;
  });
  html += `</div>`;

  // Exit arena button
  html += `<div class="settings-group">
    <button class="settings-btn" id="btn-exit-arena" style="color:var(--err);border-color:var(--err)">Exit Arena Mode</button>
  </div>`;

  content.innerHTML = html;

  // Events
  content.querySelector('#arena-mode').addEventListener('change', e => {
    cfg.mode = e.target.value;
    // Reset roles for agents
    const newRoles = roleOptions[cfg.mode] || ['worker'];
    cfg.agents.forEach(a => { if (!newRoles.includes(a.role)) a.role = newRoles[0]; });
    renderArenaTab(content);
  });

  content.querySelector('#arena-criteria')?.addEventListener('change', e => { cfg.judgeCriteria = e.target.value; });
  content.querySelector('#arena-pos-0')?.addEventListener('change', e => { cfg.debatePositions[0] = e.target.value; });
  content.querySelector('#arena-pos-1')?.addEventListener('change', e => { cfg.debatePositions[1] = e.target.value; });
  content.querySelector('#arena-debate-rounds')?.addEventListener('input', e => {
    cfg.debateRounds = parseInt(e.target.value);
    const lbl = content.querySelector('#lbl-debate-rounds');
    if (lbl) lbl.textContent = cfg.debateRounds;
  });
  content.querySelector('#arena-ref-cycles')?.addEventListener('input', e => {
    cfg.refinementCycles = parseInt(e.target.value);
    const lbl = content.querySelector('#lbl-ref-cycles');
    if (lbl) lbl.textContent = cfg.refinementCycles;
  });
  content.querySelector('#arena-orch-steps')?.addEventListener('input', e => {
    cfg.orchMaxSteps = parseInt(e.target.value);
    const lbl = content.querySelector('#lbl-orch-steps');
    if (lbl) lbl.textContent = cfg.orchMaxSteps;
  });
  content.querySelector('#arena-seq-turns')?.addEventListener('input', e => {
    cfg.seqTurns = parseInt(e.target.value);
    const lbl = content.querySelector('#lbl-seq-turns');
    if (lbl) lbl.textContent = cfg.seqTurns;
  });

  content.querySelectorAll('[data-agent-model]').forEach(sel => {
    sel.addEventListener('change', () => { cfg.agents[parseInt(sel.dataset.agentModel)].model = sel.value; });
  });
  content.querySelectorAll('[data-agent-role]').forEach(sel => {
    sel.addEventListener('change', () => { cfg.agents[parseInt(sel.dataset.agentRole)].role = sel.value; });
  });
  content.querySelectorAll('[data-agent-tools]').forEach(cb => {
    cb.addEventListener('change', () => { cfg.agents[parseInt(cb.dataset.agentTools)].enableTools = cb.checked; });
  });
  content.querySelectorAll('[data-del-agent]').forEach(btn => {
    btn.onclick = () => { cfg.agents.splice(parseInt(btn.dataset.delAgent), 1); renderArenaTab(content); };
  });
  content.querySelector('#btn-add-arena-agent').onclick = () => {
    const defaultRole = roles[0];
    cfg.agents.push({ model: state.settings.model, role: defaultRole, systemPrompt: '', enableTools: false });
    renderArenaTab(content);
  };
  content.querySelector('#btn-exit-arena').onclick = () => {
    pane.arenaMode = false;
    state.rightTab = 'chat';
    renderAll();
  };
}

function renderChatTab(content) {
  const s = state.settings;

  // Build active features summary
  const features = [];
  if (s.webSearch) features.push('Web Search');
  if (s.useMCPTools !== false && state.mcpTools.length > 0) features.push(`MCP (${state.mcpTools.length})`);
  if (s.ragEnabled && s.ragCollection) {
    const col = state.ragCollections.find(c => c.id === s.ragCollection);
    features.push(`RAG: ${col ? col.name : 'active'}`);
  }

  content.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-label">Model</div>
      <div class="settings-row">
        <select class="settings-select" id="setting-model">
          <option value="">── select model ──</option>
          ${state.models.map(m => `<option value="${esc(m.name)}" ${m.name === s.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
      </div>
      <button class="settings-btn" id="btn-open-models">Manage Models</button>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">System Prompt</div>
      <div class="settings-row">
        <textarea class="settings-input" id="setting-sysprompt" rows="3" placeholder="System prompt..." style="resize:vertical;min-height:40px;font-family:var(--font);font-size:11px">${esc(s.systemPrompt || '')}</textarea>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">Temperature <span id="lbl-temp">${s.temperature}</span></div>
      <div class="settings-row">
        <input type="range" class="settings-range" id="setting-temp" min="0" max="2" step="0.05" value="${s.temperature}">
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">Active Features</div>
      ${features.length > 0
        ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${features.map(f =>
            `<span style="font-size:10px;padding:2px 6px;background:var(--accent);color:var(--bg);border-radius:3px">${esc(f)}</span>`
          ).join('')}</div>`
        : `<div style="font-size:11px;color:var(--text-dim)">No tools or features active. Configure in Tools and Knowledge tabs.</div>`
      }
    </div>

    <div class="settings-group">
      <button class="settings-btn" id="btn-open-full-settings">⚙ Full Settings...</button>
    </div>
  `;

  // Model select
  document.getElementById('setting-model').addEventListener('change', e => {
    updateSetting('model', e.target.value);
    renderWorkspace(); // Update model badges
  });

  // System prompt
  document.getElementById('setting-sysprompt').addEventListener('change', e => {
    updateSetting('systemPrompt', e.target.value);
  });

  // Temperature slider
  const tempEl = document.getElementById('setting-temp');
  const tempLbl = document.getElementById('lbl-temp');
  tempEl.addEventListener('input', () => {
    const val = parseFloat(tempEl.value);
    if (tempLbl) tempLbl.textContent = val;
    updateSetting('temperature', val);
  });

  document.getElementById('btn-open-models').onclick = () => openModal('model-manager');
  document.getElementById('btn-open-full-settings').onclick = () => openModal('full-settings');
}

async function updateSetting(key, value) {
  state.settings[key] = value;
  try {
    await api.updateSettings({ [key]: value });
  } catch (e) {
    notify(`Failed to save setting: ${e.message}`, 'err');
  }
}

function renderToolsTab(content) {
  const s = state.settings;

  // Web Search config
  let html = `
    <div class="settings-group">
      <div class="settings-group-label">Web Search</div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px">Toggle search on/off from the input bar. Configure the engine here.</div>
      <div class="settings-row">
        <select class="settings-select" id="tools-search-engine">
          <option value="ddg" ${s.searchEngine === 'ddg' ? 'selected' : ''}>DuckDuckGo (free)</option>
          <option value="searxng" ${s.searchEngine === 'searxng' ? 'selected' : ''}>SearXNG (self-hosted)</option>
          <option value="brave" ${s.searchEngine === 'brave' ? 'selected' : ''}>Brave Search (API key)</option>
          <option value="tavily" ${s.searchEngine === 'tavily' ? 'selected' : ''}>Tavily (API key)</option>
        </select>
      </div>
      <div class="settings-row" id="tools-searxng-row" style="${s.searchEngine === 'searxng' ? '' : 'display:none'}">
        <input class="settings-input" id="tools-searxngUrl" placeholder="SearXNG URL" value="${esc(s.searxngUrl || '')}">
      </div>
      <div class="settings-row" id="tools-brave-row" style="${s.searchEngine === 'brave' ? '' : 'display:none'}">
        <input class="settings-input" id="tools-braveApiKey" type="password" placeholder="Brave API Key" value="${esc(s.braveApiKey || '')}">
      </div>
      <div class="settings-row" id="tools-tavily-row" style="${s.searchEngine === 'tavily' ? '' : 'display:none'}">
        <input class="settings-input" id="tools-tavilyApiKey" type="password" placeholder="Tavily API Key" value="${esc(s.tavilyApiKey || '')}">
      </div>
    </div>
  `;

  // MCP section
  html += `
    <div class="settings-group">
      <div class="settings-group-label">MCP Servers</div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px">Toggle MCP on/off from the input bar when servers are connected.</div>
      <div id="mcp-section">
        <button class="settings-btn" id="btn-add-mcp" style="margin-bottom:6px">+ Add Server</button>
  `;

  if (state.mcpServers.length === 0) {
    html += `<div style="font-size:11px;color:var(--text-dim);padding:4px 0">No MCP servers configured.</div>`;
  }

  for (const sv of state.mcpServers) {
    const cls = sv.connected ? 'connected' : '';
    html += `
      <div class="mcp-server-item ${cls}" data-mcp-id="${sv.id}">
        <div class="mcp-server-header">
          <span class="conn-indicator"></span>
          <span class="mcp-server-name">${esc(sv.name)}</span>
          <span class="mcp-server-type">${esc(sv.type)}</span>
        </div>
        ${sv.connected ? `<div class="mcp-tool-count">${sv.toolCount} tool${sv.toolCount !== 1 ? 's' : ''}</div>` : ''}
        <div class="mcp-server-btns">
          ${sv.connected
            ? `<button class="mcp-btn disc" data-disc-mcp="${sv.id}">Disconnect</button>`
            : `<button class="mcp-btn conn" data-conn-mcp="${sv.id}">Connect</button>`
          }
          <button class="mcp-btn" data-edit-mcp="${sv.id}">Edit</button>
          <button class="mcp-btn danger" data-del-mcp="${sv.id}">Delete</button>
        </div>
      </div>
    `;
  }

  // MCP tools list (when connected)
  if (state.mcpTools.length > 0) {
    html += `<div style="margin-top:6px">`;
    let lastServer = null;
    for (const t of state.mcpTools) {
      if (t._mcpServerName !== lastServer) {
        html += `<div style="font-size:10px;color:var(--accent2);padding:4px 0;margin-top:4px">${esc(t._mcpServerName)}</div>`;
        lastServer = t._mcpServerName;
      }
      html += `<div class="tool-item">
        <div class="tool-item-header">
          <div class="tool-item-name">${esc(t.name)}</div>
          <button class="tool-test-btn" data-test-mcp-tool="${esc(t.name)}">Test</button>
        </div>
        <div class="tool-item-desc">${esc(t.description || '')}</div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div></div>`;

  content.innerHTML = html;

  // Web search engine config
  content.querySelector('#tools-search-engine').addEventListener('change', e => {
    updateSetting('searchEngine', e.target.value);
    content.querySelector('#tools-searxng-row').style.display = e.target.value === 'searxng' ? '' : 'none';
    content.querySelector('#tools-brave-row').style.display = e.target.value === 'brave' ? '' : 'none';
    content.querySelector('#tools-tavily-row').style.display = e.target.value === 'tavily' ? '' : 'none';
  });
  content.querySelector('#tools-searxngUrl')?.addEventListener('change', e => updateSetting('searxngUrl', e.target.value));
  content.querySelector('#tools-braveApiKey')?.addEventListener('change', e => updateSetting('braveApiKey', e.target.value));
  content.querySelector('#tools-tavilyApiKey')?.addEventListener('change', e => updateSetting('tavilyApiKey', e.target.value));

  // Tool test buttons (MCP)
  content.querySelectorAll('[data-test-mcp-tool]').forEach(btn => {
    btn.onclick = () => openModal('tool-test', { name: btn.dataset.testMcpTool, isMcp: true });
  });

  // MCP server events
  const addMcpBtn = content.querySelector('#btn-add-mcp');
  if (addMcpBtn) addMcpBtn.onclick = () => openModal('mcp-server', null);

  content.querySelectorAll('[data-conn-mcp]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.connMcp;
      const item = btn.closest('.mcp-server-item');
      item.classList.add('connecting');
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api.connectMCPServer(id);
        await refreshMCPServers();
        renderToolsTab(content);
        notify('MCP server connected', 'ok');
      } catch (e) {
        item.classList.remove('connecting');
        item.classList.add('error');
        btn.disabled = false;
        btn.textContent = 'Connect';
        notify(`MCP error: ${e.message}`, 'err');
      }
    };
  });

  content.querySelectorAll('[data-disc-mcp]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.discMcp;
      try {
        await api.disconnectMCPServer(id);
        await refreshMCPServers();
        renderToolsTab(content);
        notify('MCP server disconnected', 'warn');
      } catch (e) { notify(e.message, 'err'); }
    };
  });

  content.querySelectorAll('[data-edit-mcp]').forEach(btn => {
    btn.onclick = () => {
      const sv = state.mcpServers.find(x => x.id === btn.dataset.editMcp);
      if (sv) openModal('mcp-server', sv);
    };
  });

  content.querySelectorAll('[data-del-mcp]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this MCP server?')) return;
      try {
        await api.deleteMCPServer(btn.dataset.delMcp);
        await refreshMCPServers();
        renderToolsTab(content);
        notify('MCP server deleted', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  });
}


function renderKnowledgeTab(content) {
  const s = state.settings;
  const hasEmbModel = state.models.some(m => m.name.includes('embed'));

  let html = `
    <div class="settings-group">
      <div class="settings-group-label">How it works</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;padding:2px 0">
        Create a collection, add text or URLs to it, then enable it on a chat.
        Your messages will be matched against stored knowledge to give the model extra context.
        ${!hasEmbModel ? `<div style="color:var(--warn);margin-top:4px">⚠ No embedding model found. Pull one first:<br><code style="font-size:10px">ollama pull nomic-embed-text</code></div>` : ''}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>Collections</span>
        <button class="mcp-btn" id="btn-add-rag-col">+ New</button>
      </div>
  `;

  if (state.ragCollections.length === 0) {
    html += `<div style="font-size:11px;color:var(--text-dim);padding:6px 0">No collections yet. Click + New to create one.</div>`;
  }

  for (const col of state.ragCollections) {
    const isActive = s.ragEnabled && s.ragCollection === col.id;
    html += `
      <div class="rag-col-item ${isActive ? 'active' : ''}" data-col-id="${col.id}">
        <div class="rag-col-header">
          <span class="rag-col-name">${esc(col.name)}</span>
          <div class="rag-col-btns">
            <button class="mcp-btn${isActive ? ' active' : ''}" data-use-col="${col.id}" title="${isActive ? 'Disable' : 'Use in chat'}">${isActive ? '● ON' : '○ Use'}</button>
            <button class="mcp-btn" data-view-col="${col.id}">Docs</button>
            <button class="mcp-btn danger" data-del-col="${col.id}">✕</button>
          </div>
        </div>
        ${col.description ? `<div style="font-size:10px;color:var(--text-dim)">${esc(col.description)}</div>` : ''}
      </div>
    `;
  }

  html += `</div>`;

  // Add content section
  html += `
    <div class="settings-group">
      <div class="settings-group-label">Add Content</div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px">Add a webpage or paste text into a collection</div>
      <div class="settings-row">
        <select class="settings-select" id="add-content-col">
          <option value="">── select collection ──</option>
          ${state.ragCollections.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="settings-row" style="display:flex;gap:4px">
        <input class="settings-input" id="fetch-url-input" placeholder="https://... (fetch webpage)" style="flex:1">
        <button class="settings-btn" id="btn-fetch-url" style="flex-shrink:0">Fetch</button>
      </div>
      <div class="settings-row">
        <input class="settings-input" id="add-doc-title" placeholder="Title (optional)">
      </div>
      <div class="settings-row">
        <textarea class="settings-textarea" id="add-doc-content" placeholder="Or paste text content here..." style="min-height:60px;max-height:120px"></textarea>
      </div>
      <button class="settings-btn" id="btn-add-doc">+ Add Text</button>
      <div id="add-content-status" style="font-size:10px;color:var(--text-dim);margin-top:4px"></div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">Settings</div>
      <div class="settings-row">
        <div class="settings-label">Embedding Model</div>
        <select class="settings-select" id="rag-embed-model">
          <option value="">── auto (nomic-embed-text) ──</option>
          ${state.models.filter(m => m.name.includes('embed')).map(m => `<option value="${esc(m.name)}" ${m.name === s.ragEmbeddingModel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
      </div>
      <div class="settings-row">
        <div class="settings-label">Results per query <span id="lbl-ragTopK">${s.ragTopK || 3}</span></div>
        <input type="range" class="settings-range" id="rag-topk" min="1" max="10" step="1" value="${s.ragTopK || 3}">
      </div>
    </div>
  `;

  content.innerHTML = html;

  // Embedding model selector
  document.getElementById('rag-embed-model').addEventListener('change', e => {
    updateSetting('ragEmbeddingModel', e.target.value);
  });

  // Use/disable collection toggle
  content.querySelectorAll('[data-use-col]').forEach(btn => {
    btn.onclick = async () => {
      const colId = btn.dataset.useCol;
      const isCurrentlyActive = s.ragEnabled && s.ragCollection === colId;
      if (isCurrentlyActive) {
        await updateSetting('ragEnabled', false);
        await updateSetting('ragCollection', '');
      } else {
        await updateSetting('ragCollection', colId);
        await updateSetting('ragEnabled', true);
      }
      renderKnowledgeTab(content);
      renderWorkspace(); // Update input toolbar RAG button
    };
  });

  // Top K slider
  const topkEl = document.getElementById('rag-topk');
  const topkLbl = document.getElementById('lbl-ragTopK');
  topkEl.addEventListener('input', () => {
    const val = parseInt(topkEl.value);
    if (topkLbl) topkLbl.textContent = val;
    updateSetting('ragTopK', val);
  });

  document.getElementById('btn-add-rag-col').onclick = () => openModal('rag-collection', null);

  // Fetch URL button
  document.getElementById('btn-fetch-url').onclick = async () => {
    const colId = document.getElementById('add-content-col').value;
    const url = document.getElementById('fetch-url-input').value.trim();
    if (!colId) { notify('Select a collection first', 'warn'); return; }
    if (!url) { notify('Enter a URL', 'warn'); return; }
    const statusEl = document.getElementById('add-content-status');
    const btn = document.getElementById('btn-fetch-url');
    btn.disabled = true; btn.textContent = '...';
    statusEl.textContent = 'Fetching and embedding...';
    statusEl.style.color = 'var(--text-dim)';
    try {
      const result = await api.fetchUrlToRag(colId, url);
      document.getElementById('fetch-url-input').value = '';
      statusEl.textContent = `Added ${result.chunkCount} chunks from URL`;
      statusEl.style.color = 'var(--ok)';
      notify('URL added to collection', 'ok');
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.style.color = 'var(--err)';
      notify(e.message, 'err');
    } finally { btn.disabled = false; btn.textContent = 'Fetch'; }
  };

  // Add text document button
  document.getElementById('btn-add-doc').onclick = async () => {
    const colId = document.getElementById('add-content-col').value;
    const title = document.getElementById('add-doc-title').value.trim();
    const docContent = document.getElementById('add-doc-content').value.trim();
    if (!colId) { notify('Select a collection first', 'warn'); return; }
    if (!docContent) { notify('Enter some text content', 'warn'); return; }
    const statusEl = document.getElementById('add-content-status');
    const btn = document.getElementById('btn-add-doc');
    btn.disabled = true;
    statusEl.textContent = 'Embedding and adding...';
    statusEl.style.color = 'var(--text-dim)';
    try {
      const result = await api.addRagDocument(colId, { title: title || 'Untitled', content: docContent });
      document.getElementById('add-doc-title').value = '';
      document.getElementById('add-doc-content').value = '';
      statusEl.textContent = `Added "${result.title}" (${result.chunkCount} chunks)`;
      statusEl.style.color = 'var(--ok)';
      notify('Document added', 'ok');
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.style.color = 'var(--err)';
      notify(e.message, 'err');
    } finally { btn.disabled = false; }
  };

  content.querySelectorAll('[data-view-col]').forEach(btn => {
    btn.onclick = () => {
      const col = state.ragCollections.find(c => c.id === btn.dataset.viewCol);
      if (col) openModal('rag-documents', col);
    };
  });

  content.querySelectorAll('[data-del-col]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this collection and all its documents?')) return;
      try {
        await api.deleteRagCollection(btn.dataset.delCol);
        await refreshRagCollections();
        renderKnowledgeTab(content);
        notify('Collection deleted', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  });
}

function renderStatusbar() {
  const bar = document.getElementById('statusbar');
  const activePane = state.panes.find(p => p.id === state.activePaneId);
  const chat = activePane?.chatId ? state.loadedChats[activePane.chatId] : null;
  const ctxMsgs = chat?.messages?.filter(m => m.role === 'user' || m.role === 'assistant') || [];
  const ctxUsed = ctxMsgs.length;
  const ctxLimit = state.settings.ctxLimit || 20;
  const tokenEst = ctxMsgs.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0);
  const model = (activePane?.model || state.settings.model || '').split(':')[0];

  bar.innerHTML = `
    <div class="status-item"><span class="status-key">^P</span><span class="status-val">palette</span></div>
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-key">^N</span><span class="status-val">new</span></div>
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-key">^\\</span><span class="status-val">split</span></div>
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-key">^K</span><span class="status-val">clear</span></div>
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-key">^E</span><span class="status-val">export</span></div>
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-val">${ctxUsed}/${ctxLimit} ctx</span></div>
    ${tokenEst > 0 ? `<div class="status-sep">│</div><div class="status-item"><span class="status-val">~${tokenEst > 1000 ? (tokenEst/1000).toFixed(1)+'k' : tokenEst} tok</span></div>` : ''}
    <div class="status-sep">│</div>
    <div class="status-item"><span class="status-val">${state.panes.length}p</span></div>
    ${model ? `<div class="status-sep">│</div><div class="status-item" style="color:var(--accent2);font-size:10px">${esc(model)}</div>` : ''}
  `;
}

// ─── Modals ──────────────────────────────────────────────────────────────────

let currentModal = null;

function openModal(type, data) {
  currentModal = { type, data };
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = buildModal(type, data);
  overlay.classList.add('open');
  setupModalEvents(type, data);

  // Focus first input
  const first = overlay.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 50);
}

function closeModal() {
  currentModal = null;
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('open');
  overlay.innerHTML = '';
}

function buildModal(type, data) {
  const PROJECT_COLORS = ['#00ff88', '#00ccff', '#ff6600', '#ff44aa', '#aa44ff', '#ffee00'];

  if (type === 'new-project' || type === 'edit-project') {
    const isEdit = type === 'edit-project';
    const title = isEdit ? 'EDIT PROJECT' : 'NEW PROJECT';
    const name = data?.name || '';
    const color = data?.color || PROJECT_COLORS[0];
    const chatsDir = data?.chatsDir || '';
    return `
      <div class="modal">
        <div class="modal-titlebar">
          <span class="modal-title">${title}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Project Name</label>
            <input class="modal-input" id="proj-name" value="${esc(name)}" placeholder="My Project">
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Color</label>
            <div class="color-grid" id="color-grid">
              ${PROJECT_COLORS.map(c => `<div class="color-swatch ${c === color ? 'selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></div>`).join('')}
            </div>
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Custom Chats Directory (optional)</label>
            <input class="modal-input" id="proj-chats-dir" value="${esc(chatsDir)}" placeholder="/absolute/path or relative/to/data">
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Cancel</button>
          <button class="modal-btn primary" id="modal-save">Save</button>
        </div>
      </div>
    `;
  }

  if (type === 'rename-chat') {
    return `
      <div class="modal">
        <div class="modal-titlebar">
          <span class="modal-title">RENAME CHAT</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Chat Name</label>
            <input class="modal-input" id="chat-name" value="${esc(data?.name || '')}">
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Cancel</button>
          <button class="modal-btn primary" id="modal-save">Rename</button>
        </div>
      </div>
    `;
  }

  if (type === 'mcp-server') {
    const isEdit = !!data;
    const d = data || { type: 'stdio', autoConnect: false };
    return `
      <div class="modal">
        <div class="modal-titlebar">
          <span class="modal-title">${isEdit ? 'EDIT' : 'ADD'} MCP SERVER</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Name</label>
            <input class="modal-input" id="mcp-name" value="${esc(d.name || '')}" placeholder="My MCP Server">
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Type</label>
            <select class="modal-select" id="mcp-type">
              <option value="stdio" ${d.type === 'stdio' ? 'selected' : ''}>stdio</option>
              <option value="sse" ${d.type === 'sse' ? 'selected' : ''}>sse</option>
            </select>
          </div>
          <div id="mcp-stdio-fields" style="${d.type === 'sse' ? 'display:none' : ''}">
            <div class="modal-form-row">
              <label class="modal-label">Command</label>
              <input class="modal-input" id="mcp-command" value="${esc(d.command || '')}" placeholder="npx, python, ...">
            </div>
            <div class="modal-form-row">
              <label class="modal-label">Args (space-separated)</label>
              <input class="modal-input" id="mcp-args" value="${esc(d.args || '')}" placeholder="-m server ...">
            </div>
            <div class="modal-form-row">
              <label class="modal-label">Env Vars (KEY=VALUE, one per line)</label>
              <textarea class="modal-textarea" id="mcp-env" placeholder="API_KEY=abc123">${esc(d.env || '')}</textarea>
            </div>
          </div>
          <div id="mcp-sse-fields" style="${d.type !== 'sse' ? 'display:none' : ''}">
            <div class="modal-form-row">
              <label class="modal-label">URL</label>
              <input class="modal-input" id="mcp-url" value="${esc(d.url || '')}" placeholder="http://localhost:8080/sse">
            </div>
          </div>
          <div class="modal-form-row" style="margin-top:6px">
            <div class="toggle-row">
              <span class="toggle-label">Auto-connect on startup</span>
              <label class="toggle">
                <input type="checkbox" id="mcp-auto" ${d.autoConnect ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Cancel</button>
          <button class="modal-btn primary" id="modal-save">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </div>
    `;
  }

  if (type === 'model-manager') {
    const models = state.models;
    return `
      <div class="modal" style="max-width:480px">
        <div class="modal-titlebar">
          <span class="modal-title">MODEL MANAGER</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Pull a model</label>
            <div class="pull-area">
              <input class="pull-input" id="pull-model-name" placeholder="llama3.2, mistral, ...">
              <button class="pull-btn" id="btn-pull">Pull</button>
            </div>
            <div class="pull-progress-bar" id="pull-progress-bar">
              <div class="pull-progress-fill" id="pull-progress-fill"></div>
            </div>
            <div class="pull-status" id="pull-status"></div>
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Installed Models (${models.length})</label>
            <div class="model-list" id="model-list">
              ${models.length === 0 ? '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No models installed or Ollama not connected.</div>' : ''}
              ${models.map(m => `
                <div class="model-row" data-model="${esc(m.name)}">
                  <span class="model-row-name">${esc(m.name)}</span>
                  <span class="model-row-size">${formatSize(m.size)}</span>
                  <button class="model-row-btn" data-del-model="${esc(m.name)}">Delete</button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Close</button>
        </div>
      </div>
    `;
  }

  if (type === 'tool-test') {
    const toolName = data?.name || '';
    const isMcp = data?.isMcp || false;
    // Built-in tool parameter definitions
    const builtinDefs = {
      web_fetch: [{ key: 'url', label: 'URL', placeholder: 'https://example.com' }],
      calculator: [{ key: 'expression', label: 'Expression', placeholder: '2 + 2 * 3' }],
      current_datetime: [],
      web_search: [
        { key: 'query', label: 'Query', placeholder: 'search query' },
        { key: 'engine', label: 'Engine (ddg/searxng/brave/tavily)', placeholder: 'ddg' },
      ],
    };
    // For MCP tools, generate fields from inputSchema
    let fields = builtinDefs[toolName] || [];
    if (isMcp) {
      const mcpTool = state.mcpTools.find(t => t.name === toolName);
      const schema = mcpTool?.inputSchema;
      if (schema?.properties) {
        fields = Object.entries(schema.properties).map(([key, prop]) => ({
          key,
          label: `${key}${(schema.required || []).includes(key) ? ' *' : ''}`,
          placeholder: prop.description || key,
        }));
      } else {
        fields = [];
      }
    }
    return `
      <div class="modal" style="max-width:520px">
        <div class="modal-titlebar">
          <span class="modal-title">TEST: ${esc(toolName)}${isMcp ? ' (MCP)' : ''}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          ${fields.length === 0 ? '<div style="color:var(--text-dim);font-size:11px">No parameters needed.</div>' : ''}
          ${fields.map(f => `
            <div class="modal-form-row">
              <label class="modal-label">${esc(f.label)}</label>
              <input class="modal-input tool-test-arg" data-arg-key="${esc(f.key)}" placeholder="${esc(f.placeholder)}" type="text">
            </div>
          `).join('')}
          <div class="modal-form-row" style="margin-top:4px">
            <label class="modal-label">Result</label>
            <pre class="tool-test-result" id="tool-test-result" style="background:var(--bg);border:1px solid var(--border);padding:8px;min-height:40px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--text)">─ run to see result ─</pre>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Close</button>
          <button class="modal-btn primary" id="btn-run-tool">Run</button>
        </div>
      </div>
    `;
  }

  if (type === 'rag-collection') {
    const isEdit = !!data;
    const d = data || {};
    return `
      <div class="modal">
        <div class="modal-titlebar">
          <span class="modal-title">${isEdit ? 'EDIT' : 'NEW'} COLLECTION</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Name</label>
            <input class="modal-input" id="rag-col-name" value="${esc(d.name || '')}" placeholder="My Knowledge Base">
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Description</label>
            <input class="modal-input" id="rag-col-desc" value="${esc(d.description || '')}" placeholder="Optional description">
          </div>
          <div style="font-size:10px;color:var(--text-dim);padding:4px 0">Uses the embedding model set in Knowledge tab settings (default: nomic-embed-text).</div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Cancel</button>
          <button class="modal-btn primary" id="modal-save">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    `;
  }

  if (type === 'rag-documents') {
    const col = data;
    return `
      <div class="modal" style="max-width:560px">
        <div class="modal-titlebar">
          <span class="modal-title">DOCS: ${esc(col.name)}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-form-row">
            <label class="modal-label">Add from URL</label>
            <div style="display:flex;gap:6px">
              <input class="modal-input" id="doc-url" placeholder="https://example.com/article" style="flex:1">
              <button class="modal-btn primary" id="btn-fetch-url">Fetch</button>
            </div>
            <div class="modal-form-row" style="margin-top:8px">
              <label class="modal-label">Or add text directly</label>
              <input class="modal-input" id="doc-title" placeholder="Document title">
              <textarea class="modal-textarea" id="doc-content" placeholder="Document content..." style="margin-top:6px;min-height:80px"></textarea>
              <button class="modal-btn primary" id="btn-add-doc" style="margin-top:6px;align-self:flex-start">+ Add Document</button>
            </div>
            <div id="doc-add-status" style="font-size:11px;color:var(--text-dim);padding:4px 0"></div>
          </div>
          <div class="modal-form-row">
            <label class="modal-label">Documents</label>
            <div id="doc-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
              <div style="font-size:11px;color:var(--text-dim)">Loading...</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Close</button>
        </div>
      </div>
    `;
  }

  if (type === 'full-settings') {
    const s = state.settings;
    return `
      <div class="modal full-settings-modal">
        <div class="modal-titlebar">
          <span class="modal-title">⚙ SETTINGS</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="full-settings-body">
          <div class="full-settings-tabs" id="fs-tabs">
            <button class="fs-tab active" data-fs-tab="general">General</button>
            <button class="fs-tab" data-fs-tab="generation">Generation</button>
            <button class="fs-tab" data-fs-tab="system">System</button>
          </div>
          <div class="full-settings-content" id="fs-content">
            <!-- content rendered by JS -->
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" id="modal-cancel">Close</button>
        </div>
      </div>
    `;
  }

  if (type === 'arena') {
    return `
      <div class="modal arena-modal">
        <div class="modal-titlebar">
          <span class="modal-title">⚔ARENA</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="arena-body">
          <div class="arena-config">
            <div class="modal-form-row">
              <label class="modal-label">Prompt</label>
              <textarea class="modal-textarea" id="arena-prompt" placeholder="Enter the task or question..." style="min-height:60px"></textarea>
            </div>
            <div class="modal-form-row">
              <label class="modal-label">Mode</label>
              <select class="modal-select" id="arena-mode">
                <option value="parallel">Parallel — all respond to same prompt</option>
                <option value="sequential">Sequential — pass output forward</option>
                <option value="judge">Judge — evaluate responses</option>
                <option value="debate">Debate — argue positions</option>
                <option value="refinement">Refinement — writer/critic cycles</option>
                <option value="orchestrated">Orchestrated — delegate subtasks</option>
              </select>
            </div>

            <!-- Sequential config -->
            <div id="cfg-sequential" class="arena-mode-cfg" style="display:none">
              <div class="modal-form-row">
                <label class="modal-label">Max Turns</label>
                <input type="number" class="modal-input" id="arena-turns" value="3" min="1" max="20">
              </div>
            </div>

            <!-- Judge config -->
            <div id="cfg-judge" class="arena-mode-cfg" style="display:none">
              <div class="modal-form-row">
                <label class="modal-label">Evaluation Criteria</label>
                <textarea class="modal-textarea" id="arena-judge-criteria" placeholder="e.g., accuracy, clarity, conciseness..." style="min-height:40px"></textarea>
              </div>
              <div class="modal-form-row">
                <label class="modal-label" style="font-size:10px;color:var(--text-dim)">Set one agent's role to "judge" below</label>
              </div>
            </div>

            <!-- Debate config -->
            <div id="cfg-debate" class="arena-mode-cfg" style="display:none">
              <div class="modal-form-row">
                <label class="modal-label">Rounds</label>
                <input type="number" class="modal-input" id="arena-debate-rounds" value="2" min="1" max="6">
              </div>
              <div class="modal-form-row">
                <label class="modal-label">Position A / Position B</label>
                <div style="display:flex;gap:6px">
                  <input class="modal-input" id="debate-pos-0" placeholder="For" value="For" style="flex:1">
                  <input class="modal-input" id="debate-pos-1" placeholder="Against" value="Against" style="flex:1">
                </div>
              </div>
              <div style="font-size:10px;color:var(--text-dim);padding:2px 0">Set agents to role "debater" or "judge"</div>
            </div>

            <!-- Refinement config -->
            <div id="cfg-refinement" class="arena-mode-cfg" style="display:none">
              <div class="modal-form-row">
                <label class="modal-label">Cycles</label>
                <input type="number" class="modal-input" id="arena-ref-cycles" value="2" min="1" max="5">
              </div>
              <div style="font-size:10px;color:var(--text-dim);padding:2px 0">Set agents to role "writer" or "critic"</div>
            </div>

            <!-- Orchestrated config -->
            <div id="cfg-orchestrated" class="arena-mode-cfg" style="display:none">
              <div class="modal-form-row">
                <label class="modal-label">Max Steps</label>
                <input type="number" class="modal-input" id="arena-orch-steps" value="8" min="2" max="20">
              </div>
              <div style="font-size:10px;color:var(--text-dim);padding:2px 0">Set one agent to "orchestrator", rest to "worker". Workers can enable tools.</div>
            </div>

            <div id="arena-agents">
              <label class="modal-label" style="margin-bottom:6px;display:block">Agents</label>
              <div id="arena-agents-list"></div>
              <button class="modal-btn" id="btn-add-agent" style="margin-top:6px">+ Add Agent</button>
            </div>
            <div class="modal-footer" style="padding:8px 0;border:none;flex-direction:column;gap:6px">
              <div style="display:flex;gap:6px">
                <button class="modal-btn primary" id="btn-run-arena" style="flex:1">▶ Run</button>
                <button class="modal-btn" id="btn-clear-arena">Clear</button>
              </div>
              <button class="modal-btn" id="btn-save-arena" style="display:none;color:var(--ok);border-color:var(--ok)">⬇ Save as Chat</button>
            </div>
          </div>
          <div class="arena-results" id="arena-results">
            <div style="font-size:11px;color:var(--text-dim);padding:12px">Configure agents and run to see results.</div>
          </div>
        </div>
      </div>
    `;
  }

  return '<div class="modal"><div class="modal-body">Unknown modal type</div></div>';
}

function setupModalEvents(type, data) {
  const overlay = document.getElementById('modal-overlay');

  overlay.querySelector('.modal-close')?.addEventListener('click', closeModal);
  overlay.querySelector('#modal-cancel')?.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  if (type === 'new-project' || type === 'edit-project') {
    const isEdit = type === 'edit-project';
    let selectedColor = data?.color || '#00ff88';

    overlay.querySelectorAll('.color-swatch').forEach(sw => {
      sw.onclick = () => {
        overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        selectedColor = sw.dataset.color;
      };
    });

    overlay.querySelector('#modal-save').onclick = async () => {
      const name = overlay.querySelector('#proj-name').value.trim();
      if (!name) { notify('Name required', 'warn'); return; }
      const chatsDir = overlay.querySelector('#proj-chats-dir').value.trim();
      const projectData = { name, color: selectedColor };
      if (chatsDir) projectData.chatsDir = chatsDir;
      try {
        if (isEdit) {
          const updated = await api.updateProject(data.id, projectData);
          const idx = state.projects.findIndex(p => p.id === data.id);
          if (idx !== -1) state.projects[idx] = updated;
        } else {
          const proj = await api.createProject(projectData);
          state.projects.push(proj);
        }
        renderSidebar();
        closeModal();
        notify(isEdit ? 'Project updated' : 'Project created', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  }

  if (type === 'rename-chat') {
    overlay.querySelector('#modal-save').onclick = async () => {
      const name = overlay.querySelector('#chat-name').value.trim();
      if (!name) { notify('Name required', 'warn'); return; }
      try {
        await api.updateChat(data.id, { name });
        await refreshChats();
        // Update loaded cache too
        if (state.loadedChats[data.id]) state.loadedChats[data.id].name = name;
        renderSidebar();
        renderWorkspace();
        closeModal();
        notify('Chat renamed', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  }

  if (type === 'mcp-server') {
    const typeEl = overlay.querySelector('#mcp-type');
    typeEl.addEventListener('change', () => {
      overlay.querySelector('#mcp-stdio-fields').style.display = typeEl.value === 'sse' ? 'none' : '';
      overlay.querySelector('#mcp-sse-fields').style.display = typeEl.value === 'sse' ? '' : 'none';
    });

    overlay.querySelector('#modal-save').onclick = async () => {
      const name = overlay.querySelector('#mcp-name').value.trim();
      if (!name) { notify('Name required', 'warn'); return; }
      const serverData = {
        name,
        type: overlay.querySelector('#mcp-type').value,
        autoConnect: overlay.querySelector('#mcp-auto').checked,
      };
      if (serverData.type === 'stdio') {
        serverData.command = overlay.querySelector('#mcp-command').value.trim();
        serverData.args = overlay.querySelector('#mcp-args').value.trim();
        serverData.env = overlay.querySelector('#mcp-env').value.trim();
        if (!serverData.command) { notify('Command required', 'warn'); return; }
      } else {
        serverData.url = overlay.querySelector('#mcp-url').value.trim();
        if (!serverData.url) { notify('URL required', 'warn'); return; }
      }
      try {
        if (data) {
          await api.updateMCPServer(data.id, serverData);
        } else {
          await api.createMCPServer(serverData);
        }
        await refreshMCPServers();
        renderRightPanel();
        closeModal();
        notify(data ? 'MCP server updated' : 'MCP server added', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  }

  if (type === 'model-manager') {
    overlay.querySelector('#btn-pull').onclick = () => pullModel();

    overlay.querySelectorAll('[data-del-model]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Delete model ${btn.dataset.delModel}?`)) return;
        try {
          await api.deleteModel(btn.dataset.delModel);
          await checkConnection();
          openModal('model-manager');
          notify('Model deleted', 'ok');
        } catch (e) { notify(e.message, 'err'); }
      };
    });
  }

  if (type === 'tool-test') {
    overlay.querySelector('#btn-run-tool').onclick = async () => {
      const resultEl = overlay.querySelector('#tool-test-result');
      resultEl.textContent = 'Running...';
      resultEl.style.color = 'var(--text-dim)';
      const args = {};
      overlay.querySelectorAll('.tool-test-arg').forEach(inp => {
        args[inp.dataset.argKey] = inp.value;
      });
      try {
        const resp = await api.testTool(data.name, args);
        if (resp.error) {
          resultEl.textContent = 'Error: ' + resp.error;
          resultEl.style.color = 'var(--err)';
        } else {
          resultEl.textContent = String(resp.result);
          resultEl.style.color = 'var(--ok)';
        }
      } catch (e) {
        resultEl.textContent = 'Error: ' + e.message;
        resultEl.style.color = 'var(--err)';
      }
    };
  }

  if (type === 'rag-collection') {
    const isEdit = !!data;
    overlay.querySelector('#modal-save').onclick = async () => {
      const name = overlay.querySelector('#rag-col-name').value.trim();
      if (!name) { notify('Name required', 'warn'); return; }
      const colData = {
        name,
        description: overlay.querySelector('#rag-col-desc').value.trim(),
        embeddingModel: state.settings.ragEmbeddingModel || '',
      };
      try {
        if (isEdit) {
          await api.updateRagCollection(data.id, colData);
        } else {
          await api.createRagCollection(colData);
        }
        await refreshRagCollections();
        renderRightPanel();
        closeModal();
        notify(isEdit ? 'Collection updated' : 'Collection created', 'ok');
      } catch (e) { notify(e.message, 'err'); }
    };
  }

  if (type === 'rag-documents') {
    const col = data;

    async function loadDocList() {
      const docList = overlay.querySelector('#doc-list');
      docList.innerHTML = `<div style="font-size:11px;color:var(--text-dim)">Loading...</div>`;
      try {
        const colData = await api.getRagCollection(col.id);
        const docs = colData.documents || [];
        if (docs.length === 0) {
          docList.innerHTML = `<div style="font-size:11px;color:var(--text-dim)">No documents yet. Add a URL or text below.</div>`;
        } else {
          docList.innerHTML = docs.map(d => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;background:var(--bg2);border-radius:4px">
              <div>
                <div style="font-size:11px;font-weight:500">${esc(d.title)}</div>
                <div style="font-size:10px;color:var(--text-dim)">${d.chunkCount} chunks</div>
              </div>
              <button class="mcp-btn danger" data-del-doc="${d.id}" style="font-size:10px;padding:2px 6px">✕</button>
            </div>
          `).join('');
          docList.querySelectorAll('[data-del-doc]').forEach(btn => {
            btn.onclick = async () => {
              if (!confirm('Delete this document?')) return;
              try {
                await api.deleteRagDocument(col.id, btn.dataset.delDoc);
                notify('Document deleted', 'ok');
                loadDocList();
              } catch (e) { notify(e.message, 'err'); }
            };
          });
        }
      } catch (e) {
        docList.innerHTML = `<div style="color:var(--err);font-size:11px">${esc(e.message)}</div>`;
      }
    }
    loadDocList();

    overlay.querySelector('#btn-fetch-url').onclick = async () => {
      const url = overlay.querySelector('#doc-url').value.trim();
      if (!url) { notify('Enter a URL', 'warn'); return; }
      const statusEl = overlay.querySelector('#doc-add-status');
      const btn = overlay.querySelector('#btn-fetch-url');
      btn.disabled = true;
      btn.textContent = '...';
      statusEl.textContent = 'Fetching and embedding URL...';
      statusEl.style.color = 'var(--text-dim)';
      try {
        const result = await api.fetchUrlToRag(col.id, url);
        statusEl.textContent = `Added: ${result.title} (${result.chunkCount} chunks)`;
        statusEl.style.color = 'var(--ok)';
        overlay.querySelector('#doc-url').value = '';
        notify('URL added to collection', 'ok');
        loadDocList();
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = 'var(--err)';
        notify(e.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch';
      }
    };

    overlay.querySelector('#btn-add-doc').onclick = async () => {
      const title = overlay.querySelector('#doc-title').value.trim();
      const content = overlay.querySelector('#doc-content').value.trim();
      if (!content) { notify('Content required', 'warn'); return; }
      const statusEl = overlay.querySelector('#doc-add-status');
      statusEl.textContent = 'Embedding and adding document...';
      statusEl.style.color = 'var(--text-dim)';
      const btn = overlay.querySelector('#btn-add-doc');
      btn.disabled = true;
      try {
        const result = await api.addRagDocument(col.id, { title, content });
        statusEl.textContent = `Added: ${result.title} (${result.chunkCount} chunks)`;
        statusEl.style.color = 'var(--ok)';
        overlay.querySelector('#doc-title').value = '';
        overlay.querySelector('#doc-content').value = '';
        notify('Document added', 'ok');
        loadDocList();
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = 'var(--err)';
        notify(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };
  }

  if (type === 'full-settings') {
    setupFullSettingsModal(overlay);
  }

  if (type === 'arena') {
    setupArenaModal(overlay);
  }
}

function setupFullSettingsModal(overlay) {
  const s = state.settings;
  let activeTab = 'general';

  function renderFsTab() {
    overlay.querySelectorAll('.fs-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.fsTab === activeTab);
    });

    const content = overlay.querySelector('#fs-content');

    if (activeTab === 'general') {
      content.innerHTML = `
        <div class="settings-group">
          <div class="settings-group-label">Ollama Connection</div>
          <div class="settings-row">
            <div class="settings-label">Ollama URL</div>
            <input class="settings-input" id="fs-ollamaUrl" value="${esc(s.ollamaUrl || '')}" placeholder="http://localhost:11434">
          </div>
          <button class="settings-btn" id="fs-test-conn">Test Connection</button>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Model</div>
          <div class="settings-row">
            <select class="settings-select" id="fs-model">
              <option value="">── select model ──</option>
              ${state.models.map(m => `<option value="${esc(m.name)}" ${m.name === s.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
            </select>
          </div>
          <button class="settings-btn" id="fs-open-models">Manage Models</button>
        </div>
      `;
      content.querySelector('#fs-ollamaUrl').addEventListener('change', e => updateSetting('ollamaUrl', e.target.value));
      content.querySelector('#fs-model').addEventListener('change', e => { updateSetting('model', e.target.value); renderWorkspace(); });
      content.querySelector('#fs-test-conn').onclick = async () => {
        notify('Testing connection...', 'warn');
        await checkConnection();
        notify(state.connected ? 'Connected!' : 'Connection failed', state.connected ? 'ok' : 'err');
      };
      content.querySelector('#fs-open-models').onclick = () => {
        closeModal();
        openModal('model-manager');
      };
      // Light theme toggle (append dynamically)
      const themeRow = document.createElement('div');
      themeRow.className = 'settings-group';
      themeRow.innerHTML = `
        <div class="settings-group-label">Appearance</div>
        <div class="toggle-row" style="margin-top:8px">
          <span class="toggle-label">Light theme</span>
          <label class="toggle">
            <input type="checkbox" id="fs-light-theme" ${document.body.classList.contains('theme-light') ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      `;
      content.appendChild(themeRow);
      content.querySelector('#fs-light-theme').addEventListener('change', e => {
        document.body.classList.toggle('theme-light', e.target.checked);
        localStorage.setItem('ollama-theme', e.target.checked ? 'light' : 'dark');
      });
    } else if (activeTab === 'generation') {
      content.innerHTML = `
        <div class="settings-group">
          <div class="settings-group-label">Generation Parameters</div>
          <div class="settings-row">
            <div class="settings-label">Temperature <span id="fs-lbl-temp">${s.temperature}</span></div>
            <input type="range" class="settings-range" id="fs-temp" min="0" max="2" step="0.05" value="${s.temperature}">
          </div>
          <div class="settings-row">
            <div class="settings-label">Top P <span id="fs-lbl-top_p">${s.top_p}</span></div>
            <input type="range" class="settings-range" id="fs-top_p" min="0" max="1" step="0.05" value="${s.top_p}">
          </div>
          <div class="settings-row">
            <div class="settings-label">Top K <span id="fs-lbl-top_k">${s.top_k}</span></div>
            <input type="range" class="settings-range" id="fs-top_k" min="1" max="200" step="1" value="${s.top_k}">
          </div>
          <div class="settings-row">
            <div class="settings-label">Max Tokens <span id="fs-lbl-max_tokens">${s.max_tokens}</span></div>
            <input type="range" class="settings-range" id="fs-max_tokens" min="64" max="8192" step="64" value="${s.max_tokens}">
          </div>
          <div class="settings-row">
            <div class="settings-label">Repeat Penalty <span id="fs-lbl-repeat_penalty">${s.repeat_penalty}</span></div>
            <input type="range" class="settings-range" id="fs-repeat_penalty" min="0.5" max="2" step="0.05" value="${s.repeat_penalty}">
          </div>
          <div class="settings-row">
            <div class="settings-label">Context Limit <span id="fs-lbl-ctxLimit">${s.ctxLimit}</span></div>
            <input type="range" class="settings-range" id="fs-ctxLimit" min="2" max="500" step="2" value="${s.ctxLimit}">
          </div>
        </div>
      `;
      const sliders = [
        ['fs-temp', 'fs-lbl-temp', 'temperature'],
        ['fs-top_p', 'fs-lbl-top_p', 'top_p'],
        ['fs-top_k', 'fs-lbl-top_k', 'top_k'],
        ['fs-max_tokens', 'fs-lbl-max_tokens', 'max_tokens'],
        ['fs-repeat_penalty', 'fs-lbl-repeat_penalty', 'repeat_penalty'],
        ['fs-ctxLimit', 'fs-lbl-ctxLimit', 'ctxLimit'],
      ];
      for (const [elId, lblId, key] of sliders) {
        const el = content.querySelector(`#${elId}`);
        const lbl = content.querySelector(`#${lblId}`);
        if (!el) continue;
        el.addEventListener('input', () => {
          const val = parseFloat(el.value);
          if (lbl) lbl.textContent = val;
          updateSetting(key, val);
        });
      }

      // Presets section
      const presetsGroup = document.createElement('div');
      presetsGroup.className = 'settings-group';
      presetsGroup.innerHTML = `
        <div class="settings-group-label">Presets</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap" id="preset-list-row"></div>
        <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
          <input class="settings-input" id="preset-name-input" placeholder="Preset name..." style="flex:1">
          <button class="settings-btn" id="btn-save-preset">Save current</button>
        </div>
      `;
      content.appendChild(presetsGroup);

      // Load and render presets
      const renderPresets = async () => {
        const listRow = content.querySelector('#preset-list-row');
        if (!listRow) return;
        try {
          const presets = await api.getPresets();
          listRow.innerHTML = '';
          if (presets.length === 0) {
            listRow.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">No presets saved</span>';
          }
          presets.forEach(p => {
            const tag = document.createElement('div');
            tag.style.cssText = 'display:flex;align-items:center;gap:4px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:11px';
            tag.innerHTML = `<span style="cursor:pointer" title="Load preset">${esc(p.name)}</span><button class="attach-remove" title="Delete">✕</button>`;
            tag.querySelector('span').onclick = () => {
              const params = p.params || {};
              for (const [k, v] of Object.entries(params)) updateSetting(k, v);
              renderFsTab();
              notify(`Loaded preset: ${p.name}`, 'ok');
            };
            tag.querySelector('button').onclick = async () => {
              await api.deletePreset(p.id);
              renderPresets();
            };
            listRow.appendChild(tag);
          });
        } catch {}
      };
      renderPresets();

      content.querySelector('#btn-save-preset').onclick = async () => {
        const name = content.querySelector('#preset-name-input').value.trim();
        if (!name) { notify('Enter a preset name', 'warn'); return; }
        const params = { temperature: s.temperature, top_p: s.top_p, top_k: s.top_k, max_tokens: s.max_tokens, repeat_penalty: s.repeat_penalty };
        try {
          await api.createPreset({ name, params });
          content.querySelector('#preset-name-input').value = '';
          renderPresets();
          notify(`Saved preset: ${name}`, 'ok');
        } catch (e) { notify(e.message, 'err'); }
      };

    } else if (activeTab === 'system') {
      content.innerHTML = `
        <div class="settings-group">
          <div class="settings-group-label">System Prompt</div>
          <textarea class="settings-textarea" id="fs-system" placeholder="Optional system prompt..." style="min-height:200px;max-height:400px">${esc(s.systemPrompt || '')}</textarea>
        </div>
      `;
      content.querySelector('#fs-system').addEventListener('change', e => updateSetting('systemPrompt', e.target.value));
    }
  }

  overlay.querySelectorAll('.fs-tab').forEach(btn => {
    btn.onclick = () => {
      activeTab = btn.dataset.fsTab;
      renderFsTab();
    };
  });

  renderFsTab();
}

// Arena agents state
let arenaAgents = [];
let arenaTranscript = [];

function setupArenaModal(overlay) {
  arenaAgents = [
    { name: 'Agent 1', model: state.settings.model || '', systemPrompt: '', role: 'worker', enableTools: false },
    { name: 'Agent 2', model: state.settings.model || '', systemPrompt: '', role: 'worker', enableTools: false },
  ];
  arenaTranscript = [];

  const modeEl = overlay.querySelector('#arena-mode');

  const ROLE_OPTIONS_BY_MODE = {
    parallel: ['worker'],
    sequential: ['worker'],
    judge: ['worker', 'judge'],
    debate: ['debater', 'judge'],
    refinement: ['writer', 'critic'],
    orchestrated: ['orchestrator', 'worker'],
  };

  function showModeConfig(mode) {
    overlay.querySelectorAll('.arena-mode-cfg').forEach(el => el.style.display = 'none');
    const cfgEl = overlay.querySelector(`#cfg-${mode}`);
    if (cfgEl) cfgEl.style.display = '';
  }

  modeEl.addEventListener('change', () => {
    showModeConfig(modeEl.value);
    renderAgents();
  });
  showModeConfig(modeEl.value);

  function renderAgents() {
    const list = overlay.querySelector('#arena-agents-list');
    const colors = ['var(--accent)', 'var(--accent2)', 'var(--accent3)', 'var(--warn)'];
    const mode = modeEl.value;
    const roleOptions = ROLE_OPTIONS_BY_MODE[mode] || ['worker'];
    list.innerHTML = '';
    arenaAgents.forEach((agent, i) => {
      const agentEl = document.createElement('div');
      agentEl.className = 'arena-agent-config';
      agentEl.style.borderLeftColor = colors[i % colors.length];
      const showTools = mode === 'orchestrated';
      agentEl.innerHTML = `
        <div class="arena-agent-header">
          <input class="modal-input arena-agent-name" style="flex:1;min-width:0;font-size:11px" value="${esc(agent.name)}" placeholder="Agent name" data-agent-idx="${i}" data-field="name">
          <select class="modal-select arena-agent-model" style="flex:1.5;min-width:0;font-size:10px" data-agent-idx="${i}" data-field="model">
            <option value="">── model ──</option>
            ${state.models.map(m => `<option value="${esc(m.name)}" ${m.name === agent.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
          ${arenaAgents.length > 1 ? `<button class="mcp-btn danger arena-del-agent" data-agent-idx="${i}" style="padding:2px 6px">✕</button>` : ''}
        </div>
        ${roleOptions.length > 1 ? `
        <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <span style="font-size:10px;color:var(--text-dim)">Role:</span>
          <select class="modal-select arena-agent-role" style="font-size:10px;flex:1" data-agent-idx="${i}" data-field="role">
            ${roleOptions.map(r => `<option value="${r}" ${agent.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          ${showTools ? `<label style="font-size:10px;color:var(--text-dim);display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="arena-agent-tools" data-agent-idx="${i}" ${agent.enableTools ? 'checked' : ''}> tools</label>` : ''}
        </div>` : ''}
        <textarea class="modal-textarea arena-agent-prompt" style="min-height:36px;margin-top:4px;font-size:11px" placeholder="System prompt (optional)" data-agent-idx="${i}" data-field="systemPrompt">${esc(agent.systemPrompt)}</textarea>
      `;
      list.appendChild(agentEl);
    });

    list.querySelectorAll('.arena-agent-name, .arena-agent-model, .arena-agent-role, .arena-agent-prompt').forEach(el => {
      const update = () => {
        const idx = parseInt(el.dataset.agentIdx);
        arenaAgents[idx][el.dataset.field] = el.value;
      };
      el.addEventListener('change', update);
      el.addEventListener('input', update);
    });

    list.querySelectorAll('.arena-agent-tools').forEach(el => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.agentIdx);
        arenaAgents[idx].enableTools = el.checked;
      });
    });

    list.querySelectorAll('.arena-del-agent').forEach(btn => {
      btn.onclick = () => {
        arenaAgents.splice(parseInt(btn.dataset.agentIdx), 1);
        renderAgents();
      };
    });
  }

  overlay.querySelector('#btn-add-agent').onclick = () => {
    if (arenaAgents.length >= 5) { notify('Maximum 5 agents', 'warn'); return; }
    const mode = modeEl.value;
    const roles = ROLE_OPTIONS_BY_MODE[mode] || ['worker'];
    arenaAgents.push({ name: `Agent ${arenaAgents.length + 1}`, model: state.settings.model || '', systemPrompt: '', role: roles[roles.length - 1], enableTools: false });
    renderAgents();
  };

  overlay.querySelector('#btn-clear-arena').onclick = () => {
    arenaTranscript = [];
    overlay.querySelector('#arena-results').innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:12px">Configure agents and run to see results.</div>';
    overlay.querySelector('#btn-save-arena').style.display = 'none';
  };

  overlay.querySelector('#btn-save-arena').onclick = async () => {
    if (!arenaTranscript.length) return;
    try {
      const prompt = overlay.querySelector('#arena-prompt').value.trim();
      const mode = modeEl.value;
      const result = await fetch('/api/arena/save-as-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arenaMode: mode, prompt, messages: arenaTranscript }),
      }).then(r => r.json());
      await refreshChats();
      renderSidebar();
      notify(`Saved as: ${result.name}`, 'ok');
    } catch (e) { notify('Save failed: ' + e.message, 'err'); }
  };

  overlay.querySelector('#btn-run-arena').onclick = async () => {
    const prompt = overlay.querySelector('#arena-prompt').value.trim();
    if (!prompt) { notify('Enter a prompt', 'warn'); return; }
    if (arenaAgents.some(a => !a.model)) { notify('All agents need a model', 'warn'); return; }

    const mode = modeEl.value;
    const resultsEl = overlay.querySelector('#arena-results');
    resultsEl.innerHTML = '';
    arenaTranscript = [];

    const modeConfig = {};
    if (mode === 'sequential') modeConfig.maxTurns = parseInt(overlay.querySelector('#arena-turns')?.value) || 3;
    if (mode === 'judge') {
      modeConfig.judgeCriteria = overlay.querySelector('#arena-judge-criteria')?.value.trim() || '';
      const judgeAgent = arenaAgents.find(a => a.role === 'judge');
      if (judgeAgent) modeConfig.judgeAgentName = judgeAgent.name;
    }
    if (mode === 'debate') {
      modeConfig.rounds = parseInt(overlay.querySelector('#arena-debate-rounds')?.value) || 2;
      modeConfig.debatePositions = [
        overlay.querySelector('#debate-pos-0')?.value || 'For',
        overlay.querySelector('#debate-pos-1')?.value || 'Against',
      ];
    }
    if (mode === 'refinement') modeConfig.cycles = parseInt(overlay.querySelector('#arena-ref-cycles')?.value) || 2;
    if (mode === 'orchestrated') modeConfig.maxSteps = parseInt(overlay.querySelector('#arena-orch-steps')?.value) || 8;

    const agentColors = { };
    const colors = ['var(--accent)', 'var(--accent2)', 'var(--accent3)', 'var(--warn)', '#aa44ff'];
    arenaAgents.forEach((a, i) => { agentColors[a.name] = colors[i % colors.length]; });

    const runBtn = overlay.querySelector('#btn-run-arena');
    runBtn.disabled = true;
    runBtn.textContent = '⟳ Running...';

    // Track current block per agent-step key
    let currentOrchBlock = null;
    let currentWorkerBlock = null;

    function getOrCreateAgentBlock(agentName, model, turn, role, extra = '') {
      const color = agentColors[agentName] || 'var(--accent)';
      const roleLabel = role && role !== 'worker' ? ` [${role.toUpperCase()}]` : '';
      const block = document.createElement('div');
      block.className = 'arena-agent-block';
      block.style.borderLeftColor = color;
      block.innerHTML = `
        <div class="arena-agent-label" style="color:${color}">${esc(agentName)}${roleLabel} <span style="color:var(--text-dim);font-size:10px">(${esc(model || '')})${extra ? ' ' + extra : ''}</span></div>
        <div class="arena-agent-text"></div>
      `;
      resultsEl.appendChild(block);
      resultsEl.scrollTop = resultsEl.scrollHeight;
      return block;
    }

    function appendToLatestBlock(agentName, text) {
      const allBlocks = resultsEl.querySelectorAll('.arena-agent-block');
      for (let i = allBlocks.length - 1; i >= 0; i--) {
        const lbl = allBlocks[i].querySelector('.arena-agent-label');
        if (lbl && lbl.textContent.startsWith(agentName)) {
          const textEl = allBlocks[i].querySelector('.arena-agent-text');
          if (textEl) { textEl.textContent += text; resultsEl.scrollTop = resultsEl.scrollHeight; }
          return;
        }
      }
    }

    try {
      const res = await fetch('/api/arena/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: arenaAgents, initialPrompt: prompt, mode, modeConfig }),
      });

      if (!res.ok) { notify('Arena request failed', 'err'); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = 'message', dataStr = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }

          switch (eventType) {
            case 'agent_start': {
              const extra = data.turn ? `turn ${data.turn}` : '';
              const block = getOrCreateAgentBlock(data.agentName, data.model, data.turn, data.role, extra);
              break;
            }
            case 'delta':
              appendToLatestBlock(data.agentName, data.text);
              break;

            case 'agent_done':
              arenaTranscript.push({ role: 'assistant', content: data.content, agentName: data.agentName, timestamp: Date.now() });
              break;

            case 'round_start': {
              const divider = document.createElement('div');
              divider.className = 'arena-round-divider';
              divider.textContent = `── ROUND ${data.round} / ${data.totalRounds} ──`;
              resultsEl.appendChild(divider);
              break;
            }

            case 'judge_result': {
              const verdictEl = document.createElement('div');
              verdictEl.className = 'arena-judge-verdict';
              const winnerColor = data.winner ? (agentColors[data.winner] || 'var(--ok)') : 'var(--ok)';
              verdictEl.innerHTML = `
                <div class="arena-judge-title" style="color:${winnerColor}">▶ VERDICT: ${esc(data.winner || 'N/A')}</div>
                <div class="arena-scores">
                  ${(data.scores || []).map(s => `
                    <div class="arena-score-row">
                      <span class="arena-score-agent" style="color:${agentColors[s.agent] || 'var(--text)'}">${esc(s.agent)}</span>
                      <div class="arena-score-bar-wrap"><div class="arena-score-bar-fill" style="width:${Math.round((s.score || 0) * 10)}%;background:${agentColors[s.agent] || 'var(--accent)'}"></div></div>
                      <span class="arena-score-num">${s.score}/10</span>
                    </div>
                    <div class="arena-score-reason">${esc(s.reasoning || '')}</div>
                  `).join('')}
                </div>
                ${data.summary ? `<div class="arena-judge-summary">${esc(data.summary)}</div>` : ''}
              `;
              resultsEl.appendChild(verdictEl);
              resultsEl.scrollTop = resultsEl.scrollHeight;
              break;
            }

            case 'refinement_cycle_done': {
              const marker = document.createElement('div');
              marker.className = 'arena-round-divider';
              marker.textContent = `── CYCLE ${data.cycle} / ${data.cycles} COMPLETE ──`;
              resultsEl.appendChild(marker);
              break;
            }

            case 'refinement_final': {
              const finalEl = document.createElement('div');
              finalEl.className = 'arena-agent-block arena-final-draft';
              finalEl.style.borderLeftColor = 'var(--ok)';
              finalEl.innerHTML = `<div class="arena-agent-label" style="color:var(--ok)">FINAL DRAFT</div><div class="arena-agent-text">${esc(data.finalDraft || '')}</div>`;
              resultsEl.appendChild(finalEl);
              resultsEl.scrollTop = resultsEl.scrollHeight;
              arenaTranscript.push({ role: 'assistant', content: data.finalDraft, agentName: 'Final Draft', timestamp: Date.now() });
              break;
            }

            case 'orchestrator_thinking': {
              currentOrchBlock = document.createElement('div');
              currentOrchBlock.className = 'arena-agent-block arena-orch-block';
              currentOrchBlock.style.borderLeftColor = 'var(--accent3)';
              currentOrchBlock.innerHTML = `
                <div class="arena-agent-label" style="color:var(--accent3)">ORCHESTRATOR <span class="arena-orch-status" style="color:var(--text-dim);font-size:10px">step ${data.step} — thinking...</span></div>
                <div class="arena-orch-raw" style="font-size:10px;color:var(--text-dim);max-height:50px;overflow:hidden"></div>
              `;
              resultsEl.appendChild(currentOrchBlock);
              resultsEl.scrollTop = resultsEl.scrollHeight;
              break;
            }

            case 'orchestrator_delta':
              if (currentOrchBlock) {
                const rawEl = currentOrchBlock.querySelector('.arena-orch-raw');
                if (rawEl) rawEl.textContent += data.text;
              }
              break;

            case 'orchestrator_command':
              if (currentOrchBlock) {
                const statusEl = currentOrchBlock.querySelector('.arena-orch-status');
                if (statusEl) {
                  if (data.action === 'delegate') statusEl.innerHTML = `step ${data.step} → <span style="color:var(--accent2)">${esc(data.worker)}</span>: ${esc((data.task || '').slice(0, 60))}${(data.task || '').length > 60 ? '...' : ''}`;
                  else if (data.action === 'finalize') statusEl.innerHTML = `<span style="color:var(--ok)">step ${data.step} → finalizing</span>`;
                }
              }
              break;

            case 'worker_start': {
              currentWorkerBlock = document.createElement('div');
              currentWorkerBlock.className = 'arena-agent-block arena-worker-block';
              currentWorkerBlock.style.borderLeftColor = agentColors[data.worker] || 'var(--accent2)';
              currentWorkerBlock.innerHTML = `
                <div class="arena-agent-label" style="color:${agentColors[data.worker] || 'var(--accent2)'}">WORKER: ${esc(data.worker)} <span style="color:var(--text-dim);font-size:10px">(${esc(data.model || '')})</span></div>
                <div class="arena-worker-task" style="font-size:10px;color:var(--text-dim);padding:2px 0 4px">${esc((data.task || '').slice(0, 120))}${(data.task || '').length > 120 ? '...' : ''}</div>
                <div class="arena-worker-tools"></div>
                <div class="arena-agent-text"></div>
              `;
              resultsEl.appendChild(currentWorkerBlock);
              resultsEl.scrollTop = resultsEl.scrollHeight;
              break;
            }

            case 'worker_delta':
              if (currentWorkerBlock) {
                const textEl = currentWorkerBlock.querySelector('.arena-agent-text');
                if (textEl) { textEl.textContent += data.text; resultsEl.scrollTop = resultsEl.scrollHeight; }
              }
              break;

            case 'worker_tool_call':
              if (currentWorkerBlock) {
                const toolsEl = currentWorkerBlock.querySelector('.arena-worker-tools');
                if (toolsEl) {
                  const toolEl = document.createElement('div');
                  toolEl.className = 'arena-tool-call';
                  toolEl.dataset.toolId = data.id;
                  toolEl.innerHTML = `<span style="color:var(--accent3)">⚙ ${esc(data.name)}</span> <span style="color:var(--text-dim);font-size:10px">running...</span>`;
                  toolsEl.appendChild(toolEl);
                }
              }
              break;

            case 'worker_tool_result':
              if (currentWorkerBlock) {
                const toolEl = currentWorkerBlock.querySelector(`[data-tool-id="${CSS.escape(data.id)}"]`);
                if (toolEl) {
                  const statusSpan = toolEl.querySelector('span:last-child');
                  if (statusSpan) { statusSpan.textContent = `done`; statusSpan.style.color = 'var(--ok)'; }
                }
              }
              break;

            case 'worker_done':
              if (data.result) arenaTranscript.push({ role: 'assistant', content: data.result, agentName: data.worker, timestamp: Date.now() });
              break;

            case 'orchestrator_final': {
              const finalEl = document.createElement('div');
              finalEl.className = 'arena-agent-block arena-final-answer';
              finalEl.style.borderLeftColor = 'var(--ok)';
              finalEl.innerHTML = `<div class="arena-agent-label" style="color:var(--ok)">FINAL ANSWER <span style="color:var(--text-dim);font-size:10px">(${data.steps} steps)</span></div><div class="arena-agent-text">${esc(data.answer || '')}</div>`;
              resultsEl.appendChild(finalEl);
              resultsEl.scrollTop = resultsEl.scrollHeight;
              arenaTranscript.push({ role: 'assistant', content: data.answer, agentName: 'Orchestrator', timestamp: Date.now() });
              break;
            }

            case 'done':
              overlay.querySelector('#btn-save-arena').style.display = arenaTranscript.length ? '' : 'none';
              break;

            case 'error':
              notify('Arena error: ' + data.message, 'err');
              break;
          }
        }
      }
    } catch (e) {
      notify('Arena error: ' + e.message, 'err');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '▶ Run';
    }
  };

  renderAgents();
}

async function pullModel() {
  const nameEl = document.getElementById('pull-model-name');
  const name = nameEl?.value.trim();
  if (!name) { notify('Enter model name', 'warn'); return; }

  const bar = document.getElementById('pull-progress-bar');
  const fill = document.getElementById('pull-progress-fill');
  const status = document.getElementById('pull-status');
  const btn = document.getElementById('btn-pull');

  bar.classList.add('active');
  btn.disabled = true;
  status.textContent = 'Starting pull...';

  try {
    const res = await fetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          status.textContent = obj.status || '';
          if (obj.total && obj.completed) {
            fill.style.width = Math.round((obj.completed / obj.total) * 100) + '%';
          } else if (obj.status === 'success') {
            fill.style.width = '100%';
          }
        } catch {}
      }
    }
    status.textContent = 'Done!';
    await checkConnection();
    notify(`Model ${name} pulled`, 'ok');
    setTimeout(() => openModal('model-manager'), 500);
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    notify(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

let ctxChatId = null;

function openContextMenu(e, chatId) {
  ctxChatId = chatId;
  const chat = state.chats.find(c => c.id === ctxChatId);
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <button class="ctx-item" id="ctx-rename">✎ Rename</button>
    <button class="ctx-item" id="ctx-pin">${chat?.pinned ? '📌 Unpin' : '📌 Pin'}</button>
    <button class="ctx-item" id="ctx-star">${chat?.starred ? '☆ Unstar' : '★ Star'}</button>
    <div class="ctx-sep"></div>
    <div class="ctx-item has-sub" style="position:relative">
      ⊞ Move to Project
      <div class="ctx-sub" id="ctx-sub-move">
        <button class="ctx-item" data-move-project="null">── None (ungrouped) ──</button>
        ${state.projects.map(p => `<button class="ctx-item" data-move-project="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>
    </div>
    <div class="ctx-sep"></div>
    <button class="ctx-item" id="ctx-export">⬇ Export JSON</button>
    <button class="ctx-item danger" id="ctx-delete">✕ Delete</button>
  `;
  menu.classList.add('open');

  // Position
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  menu.querySelector('#ctx-rename').onclick = () => {
    closeCtxMenu();
    const chat = state.chats.find(c => c.id === ctxChatId);
    if (chat) openModal('rename-chat', chat);
  };

  menu.querySelector('#ctx-pin').onclick = async () => {
    closeCtxMenu();
    const chat = state.chats.find(c => c.id === ctxChatId);
    if (!chat) return;
    const newVal = !chat.pinned;
    try {
      await api.updateChat(ctxChatId, { pinned: newVal });
      chat.pinned = newVal;
      if (state.loadedChats[ctxChatId]) state.loadedChats[ctxChatId].pinned = newVal;
      await refreshChats();
      renderSidebar();
      notify(newVal ? 'Chat pinned' : 'Chat unpinned', 'ok');
    } catch (e2) { notify(e2.message, 'err'); }
  };

  menu.querySelector('#ctx-star').onclick = async () => {
    closeCtxMenu();
    const chat = state.chats.find(c => c.id === ctxChatId);
    if (!chat) return;
    const newVal = !chat.starred;
    try {
      await api.updateChat(ctxChatId, { starred: newVal });
      chat.starred = newVal;
      if (state.loadedChats[ctxChatId]) state.loadedChats[ctxChatId].starred = newVal;
      await refreshChats();
      renderSidebar();
      notify(newVal ? 'Starred' : 'Unstarred', 'ok');
    } catch (e2) { notify(e2.message, 'err'); }
  };

  menu.querySelectorAll('[data-move-project]').forEach(btn => {
    btn.onclick = async () => {
      closeCtxMenu();
      const projId = btn.dataset.moveProject === 'null' ? null : btn.dataset.moveProject;
      try {
        await api.updateChat(ctxChatId, { projectId: projId });
        if (state.loadedChats[ctxChatId]) state.loadedChats[ctxChatId].projectId = projId;
        await refreshChats();
        renderSidebar();
        notify('Chat moved', 'ok');
      } catch (e2) { notify(e2.message, 'err'); }
    };
  });

  menu.querySelector('#ctx-export').onclick = () => {
    closeCtxMenu();
    exportChat(ctxChatId);
  };

  menu.querySelector('#ctx-delete').onclick = async () => {
    closeCtxMenu();
    if (!confirm('Delete this chat?')) return;
    try {
      await api.deleteChat(ctxChatId);
      // Clear from panes
      for (const pane of state.panes) {
        if (pane.chatId === ctxChatId) pane.chatId = null;
      }
      delete state.loadedChats[ctxChatId];
      await refreshChats();
      renderSidebar();
      renderWorkspace();
      notify('Chat deleted', 'ok');
    } catch (e) { notify(e.message, 'err'); }
  };
}

function closeCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('open');
  menu.innerHTML = '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - new Date(ts).getTime();
  if (diff < 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return Math.floor(days / 30) + 'mo ago';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(1) + ' KB';
}

async function newChatInActivePane(projectId = null) {
  await newChatInPane(state.activePaneId, projectId);
}

async function newChatInPane(paneId, projectId = null) {
  try {
    const chat = await api.createChat({ name: 'New Chat', projectId });
    state.loadedChats[chat.id] = chat;
    await refreshChats();
    const pane = state.panes.find(p => p.id === paneId);
    if (pane) pane.chatId = chat.id;
    renderSidebar();
    renderWorkspace();
    saveUIState();
    // Focus textarea
    setTimeout(() => {
      const ta = document.querySelector(`#pane-${paneId} .pane-textarea`);
      if (ta) ta.focus();
    }, 50);
  } catch (e) {
    notify(`Failed to create chat: ${e.message}`, 'err');
  }
}

async function stopStreaming(paneId) {
  const pane = state.panes.find(p => p.id === paneId);
  if (!pane) return;
  pane.controller?.abort();
  pane.streaming = false;
  pane.controller = null;
  // Save partial response if any content was streamed
  if (pane.streamText && pane.chatId && state.loadedChats[pane.chatId]) {
    const chat = state.loadedChats[pane.chatId];
    // Update the streaming placeholder message with actual content
    const streamingMsg = chat.messages.find(m => m._streaming);
    if (streamingMsg) {
      streamingMsg.content = pane.streamText;
      streamingMsg._streaming = false;
      try { await api.updateChat(pane.chatId, { messages: chat.messages }); } catch {}
    }
  }
  renderPane(pane);
}

async function exportChat(chatId) {
  try {
    const chat = state.loadedChats[chatId] || await api.getChat(chatId);
    const json = JSON.stringify(chat, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(chat.name || 'chat').replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Chat exported', 'ok');
  } catch (e) {
    notify(e.message, 'err');
  }
}

// ─── Project Context Menu ─────────────────────────────────────────────────────

function openProjectContextMenu(e, projectId) {
  const proj = state.projects.find(p => p.id === projectId);
  if (!proj) return;
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <button class="ctx-item" id="ctx-proj-edit">✎ Edit Project</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item danger" id="ctx-proj-delete">✕ Delete Project</button>
  `;
  menu.classList.add('open');
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 120);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelector('#ctx-proj-edit').onclick = () => { closeCtxMenu(); openModal('edit-project', proj); };
  menu.querySelector('#ctx-proj-delete').onclick = async () => {
    closeCtxMenu();
    if (!confirm('Delete project? Chats will remain ungrouped.')) return;
    try {
      await api.deleteProject(projectId);
      const projChats = state.chats.filter(c => c.projectId === projectId);
      for (const c of projChats) await api.updateChat(c.id, { projectId: null });
      state.projects = state.projects.filter(p => p.id !== projectId);
      await refreshChats();
      renderSidebar();
      notify('Project deleted', 'ok');
    } catch (e2) { notify(e2.message, 'err'); }
  };
}

// ─── Pane Model Picker ────────────────────────────────────────────────────────

function openPaneModelPicker(anchorEl, pane) {
  document.querySelector('.pane-model-picker')?.remove();
  const picker = document.createElement('div');
  picker.className = 'pane-model-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:9999;background:var(--panel);border:1px solid var(--border);min-width:160px;max-height:200px;overflow-y:auto;`;

  const globalOpt = document.createElement('div');
  globalOpt.className = 'pane-model-option' + (!pane.model ? ' active' : '');
  globalOpt.textContent = '⚙ Use global setting';
  globalOpt.onclick = () => {
    pane.model = null;
    picker.remove();
    renderPane(pane);
    saveUIState();
  };
  picker.appendChild(globalOpt);

  for (const m of state.models) {
    const opt = document.createElement('div');
    opt.className = 'pane-model-option' + (m.name === pane.model ? ' active' : '');
    opt.textContent = m.name;
    opt.onclick = () => {
      pane.model = m.name;
      picker.remove();
      renderPane(pane);
      saveUIState();
    };
    picker.appendChild(opt);
  }

  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener('click', function remove() {
    picker.remove();
    document.removeEventListener('click', remove);
  }), 10);
}

// ─── Command Palette ──────────────────────────────────────────────────────────

function openCommandPalette() {
  document.querySelector('#cmd-palette-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cmd-palette-overlay';
  overlay.className = 'cmd-palette-overlay';

  const palette = document.createElement('div');
  palette.className = 'cmd-palette';

  const input = document.createElement('input');
  input.className = 'cmd-palette-input';
  input.placeholder = 'Search commands, chats, models...';

  const results = document.createElement('div');
  results.className = 'cmd-palette-results';

  palette.appendChild(input);
  palette.appendChild(results);
  overlay.appendChild(palette);
  document.body.appendChild(overlay);

  const COMMANDS = [
    { label: 'New Chat', hint: 'Ctrl+N', action: () => { overlay.remove(); newChatInActivePane(); } },
    { label: 'Split Pane', hint: 'Ctrl+\\', action: () => { overlay.remove(); addPane(); } },
    { label: 'Close Pane', hint: 'Ctrl+W', action: () => { overlay.remove(); removePane(state.activePaneId); } },
    { label: 'Open Settings', action: () => { overlay.remove(); openModal('full-settings'); } },
    { label: 'Open Model Manager', action: () => { overlay.remove(); openModal('model-manager'); } },
    { label: 'Open Arena', action: () => { overlay.remove(); openModal('arena'); } },
    { label: 'New Project', action: () => { overlay.remove(); openModal('new-project'); } },
    { label: 'Export Current Chat', hint: 'Ctrl+E', action: () => { overlay.remove(); const p = state.panes.find(x => x.id === state.activePaneId); if (p?.chatId) exportChat(p.chatId); } },
    { label: 'Clear Current Chat', hint: 'Ctrl+K', action: async () => { overlay.remove(); const p = state.panes.find(x => x.id === state.activePaneId); if (p?.chatId && confirm('Clear chat?')) { await api.updateChat(p.chatId, { messages: [] }); if (state.loadedChats[p.chatId]) state.loadedChats[p.chatId].messages = []; renderPane(p); } } },
    ...state.chats.map(c => ({ label: `Open: ${c.name}`, hint: 'chat', action: () => { overlay.remove(); openChatInPane(c.id); } })),
    ...state.models.map(m => ({ label: `Switch model: ${m.name}`, hint: 'model', action: () => { overlay.remove(); updateSetting('model', m.name); renderWorkspace(); notify(`Model: ${m.name}`, 'ok'); } })),
  ];

  let selectedIdx = 0;

  function fuzzyScore(label, query) {
    if (!query) return 1;
    const l = label.toLowerCase();
    const q = query.toLowerCase();
    if (l.includes(q)) return 2;
    let qi = 0;
    for (let i = 0; i < l.length && qi < q.length; i++) {
      if (l[i] === q[qi]) qi++;
    }
    return qi === q.length ? 1 : 0;
  }

  function renderResults(query) {
    const scored = COMMANDS
      .map(c => ({ ...c, score: fuzzyScore(c.label, query) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    results.innerHTML = '';
    selectedIdx = 0;
    scored.forEach((cmd, i) => {
      const item = document.createElement('div');
      item.className = 'cmd-result' + (i === 0 ? ' selected' : '');
      item.innerHTML = `<span class="cmd-result-label">${esc(cmd.label)}</span>${cmd.hint ? `<span class="cmd-result-hint">${esc(cmd.hint)}</span>` : ''}`;
      item.onclick = () => cmd.action();
      item.onmouseenter = () => {
        results.querySelectorAll('.cmd-result').forEach((el, j) => el.classList.toggle('selected', j === i));
        selectedIdx = i;
      };
      results.appendChild(item);
    });
    return scored;
  }

  let currentScored = renderResults('');

  input.addEventListener('input', () => {
    currentScored = renderResults(input.value);
  });

  input.addEventListener('keydown', e => {
    const items = results.querySelectorAll('.cmd-result');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentScored[selectedIdx]) currentScored[selectedIdx].action();
    } else if (e.key === 'Escape') {
      overlay.remove();
    }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  setTimeout(() => input.focus(), 10);
}

// ─── Cross-Chat Search ────────────────────────────────────────────────────────

function openChatSearchModal() {
  document.querySelector('#chat-search-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'chat-search-overlay';
  overlay.className = 'cmd-palette-overlay';
  overlay.innerHTML = `
    <div class="cmd-palette" style="max-width:600px;width:96vw">
      <input class="cmd-palette-input" id="chat-search-q" placeholder="Search all chats...">
      <div class="cmd-palette-results" id="chat-search-results" style="max-height:400px">
        <div style="padding:12px;font-size:11px;color:var(--text-dim)">Type to search across all chats</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const input = overlay.querySelector('#chat-search-q');
  const results = overlay.querySelector('#chat-search-results');
  input.focus();

  let searchTimeout;
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    if (!input.value.trim()) { results.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-dim)">Type to search across all chats</div>'; return; }
    results.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-dim)">Searching...</div>';
    searchTimeout = setTimeout(async () => {
      try {
        const hits = await api.searchChats(input.value.trim());
        if (!hits.length) { results.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-dim)">No results</div>'; return; }
        results.innerHTML = '';
        hits.forEach(hit => {
          const item = document.createElement('div');
          item.className = 'cmd-result';
          item.style.flexDirection = 'column';
          item.style.alignItems = 'flex-start';
          item.style.gap = '2px';
          item.innerHTML = `
            <div style="display:flex;width:100%;justify-content:space-between">
              <span class="cmd-result-label">${esc(hit.chatName)}</span>
              <span class="cmd-result-hint">${esc(hit.role)}</span>
            </div>
            <div style="font-size:10px;color:var(--text-dim);white-space:normal;line-height:1.4">...${esc(hit.excerpt)}...</div>
          `;
          item.onclick = () => {
            overlay.remove();
            openChatInPane(hit.chatId);
          };
          results.appendChild(item);
        });
      } catch (e) {
        results.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--err)">${esc(e.message)}</div>`;
      }
    }, 300);
  });

  input.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });
}

// ─── Pane Search ──────────────────────────────────────────────────────────────

function togglePaneSearch(paneId) {
  const bar = document.getElementById(`pane-search-${paneId}`);
  if (!bar) return;
  const isOpen = bar.style.display !== 'none';
  if (isOpen) {
    bar.style.display = 'none';
    clearPaneSearchHighlights(paneId);
  } else {
    bar.style.display = 'flex';
    const searchInput = bar.querySelector('.pane-search-input');
    searchInput.focus();
    searchInput.addEventListener('input', (e) => {
      doPaneSearch(paneId, e.target.value);
    });
    document.getElementById(`pane-search-close-${paneId}`).onclick = () => {
      bar.style.display = 'none';
      clearPaneSearchHighlights(paneId);
    };
  }
}

function doPaneSearch(paneId, query) {
  clearPaneSearchHighlights(paneId);
  if (!query.trim()) return;
  const msgsEl = document.querySelector(`#pane-${paneId} .pane-messages`);
  if (!msgsEl) return;
  const bodies = msgsEl.querySelectorAll('.msg-body');
  let count = 0;
  const q = query.toLowerCase();
  bodies.forEach(body => {
    const text = body.textContent || '';
    if (text.toLowerCase().includes(q)) {
      count++;
      body.classList.add('search-match');
    }
  });
  const countEl = document.querySelector(`#pane-search-${paneId} .pane-search-count`);
  if (countEl) countEl.textContent = count ? `${count} match${count !== 1 ? 'es' : ''}` : 'no matches';
  const first = msgsEl.querySelector('.search-match');
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearPaneSearchHighlights(paneId) {
  const msgsEl = document.querySelector(`#pane-${paneId} .pane-messages`);
  if (!msgsEl) return;
  msgsEl.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
  const countEl = document.querySelector(`#pane-search-${paneId} .pane-search-count`);
  if (countEl) countEl.textContent = '';
}

// ─── Chat Import ──────────────────────────────────────────────────────────────

function importChat() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let messages = [];
      let name = file.name.replace('.json', '');

      if (data.mapping && typeof data.mapping === 'object') {
        name = data.title || name;
        const walk = (nodeId) => {
          const node = data.mapping[nodeId];
          if (!node) return;
          if (node.message?.content?.parts) {
            const role = node.message.author?.role;
            if (role === 'user' || role === 'assistant') {
              const content = node.message.content.parts.filter(p => typeof p === 'string').join('');
              if (content) messages.push({ role, content, timestamp: (node.message.create_time || 0) * 1000 });
            }
          }
          (node.children || []).forEach(walk);
        };
        const rootKey = Object.keys(data.mapping).find(k => !data.mapping[k].parent);
        if (rootKey) walk(rootKey);
      } else if (Array.isArray(data.messages)) {
        messages = data.messages.filter(m => m.role && m.content);
        name = data.name || name;
      } else if (Array.isArray(data)) {
        messages = data.filter(m => m.role && m.content);
      }

      if (messages.length === 0) { notify('No messages found in file', 'warn'); return; }

      const chat = await api.createChat({ name, messages });
      state.loadedChats[chat.id] = chat;
      await refreshChats();
      openChatInPane(chat.id);
      notify(`Imported: ${name} (${messages.length} messages)`, 'ok');
    } catch (err) {
      notify(`Import failed: ${err.message}`, 'err');
    }
  };
  input.click();
}

// ─── Resize Handles ───────────────────────────────────────────────────────────

function setupResizeHandles() {
  const sidebar = document.getElementById('sidebar');
  const rightPanel = document.getElementById('right-panel');
  const resizeLeft = document.getElementById('resize-left');
  const resizeRight = document.getElementById('resize-right');

  setupDrag(resizeLeft, (dx) => {
    const w = sidebar.offsetWidth + dx;
    if (w >= 140 && w <= 400) {
      sidebar.style.width = w + 'px';
      saveUIState();
    }
  });

  setupDrag(resizeRight, (dx) => {
    const w = rightPanel.offsetWidth - dx;
    if (w >= 200 && w <= 480) {
      rightPanel.style.width = w + 'px';
      saveUIState();
    }
  });
}

function setupPaneDividerDrag() {
  document.querySelectorAll('.pane-divider').forEach(div => {
    setupDrag(div, (dx) => {
      const paneId = div.dataset.dividerBefore;
      const paneIdx = state.panes.findIndex(p => p.id === paneId);
      if (paneIdx <= 0) return;
      const leftPane = document.getElementById(`pane-${state.panes[paneIdx - 1].id}`);
      const rightPane = document.getElementById(`pane-${paneId}`);
      if (!leftPane || !rightPane) return;
      const leftW = leftPane.offsetWidth + dx;
      const rightW = rightPane.offsetWidth - dx;
      if (leftW > 200 && rightW > 200) {
        leftPane.style.flex = `0 0 ${leftW}px`;
        rightPane.style.flex = `0 0 ${rightW}px`;
      }
    });
  });
}

function setupDrag(handle, onMove) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.classList.add('no-select');
    let lastX = e.clientX;

    const onMouseMove = (e2) => {
      const dx = e2.clientX - lastX;
      lastX = e2.clientX;
      onMove(dx);
    };
    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('no-select');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', async e => {
    // Close modal or stop streaming
    if (e.key === 'Escape') {
      if (document.getElementById('modal-overlay').classList.contains('open')) {
        closeModal();
        return;
      }
      if (document.getElementById('ctx-menu').classList.contains('open')) {
        closeCtxMenu();
        return;
      }
      // Stop streaming in active pane
      const pane = state.panes.find(p => p.id === state.activePaneId);
      if (pane?.streaming) stopStreaming(state.activePaneId);
      return;
    }

    if (e.ctrlKey) {
      switch (e.key) {
        case 'n':
          e.preventDefault();
          newChatInActivePane();
          break;
        case 'w':
          e.preventDefault();
          removePane(state.activePaneId);
          break;
        case '\\':
          e.preventDefault();
          addPane();
          break;
        case 'p':
          e.preventDefault();
          openCommandPalette();
          break;
        case 'f':
          e.preventDefault();
          togglePaneSearch(state.activePaneId);
          break;
        case 'F': // Ctrl+Shift+F
          if (e.shiftKey) {
            e.preventDefault();
            openChatSearchModal();
          }
          break;
        case 'k': {
          e.preventDefault();
          const pane = state.panes.find(p => p.id === state.activePaneId);
          if (pane?.chatId) {
            if (!confirm('Clear this chat?')) break;
            try {
              await api.updateChat(pane.chatId, { messages: [] });
              if (state.loadedChats[pane.chatId]) state.loadedChats[pane.chatId].messages = [];
              renderPane(pane);
            } catch (ex) { notify(ex.message, 'err'); }
          }
          break;
        }
        case 'e': {
          e.preventDefault();
          const pane = state.panes.find(p => p.id === state.activePaneId);
          if (pane?.chatId) exportChat(pane.chatId);
          break;
        }
        case '1': case '2': case '3': case '4': {
          e.preventDefault();
          const idx = parseInt(e.key) - 1;
          if (state.panes[idx]) setActivePaneId(state.panes[idx].id);
          break;
        }
      }
    }
  });
}

// ─── Global click/context handlers ───────────────────────────────────────────

function setupGlobalHandlers() {
  document.addEventListener('click', e => {
    // Close context menu on outside click
    const menu = document.getElementById('ctx-menu');
    if (menu.classList.contains('open') && !menu.contains(e.target)) {
      closeCtxMenu();
    }
  });
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  try {
    configureMarked(); // Set up marked.js with syntax highlighting
    // Load data
    [state.settings, state.projects, state.chats, state.mcpServers, state.mcpTools] = await Promise.all([
      api.getSettings().catch(() => state.settings),
      api.getProjects().catch(() => []),
      api.getChats().catch(() => []),
      api.getMCPServers().catch(() => []),
      api.getMCPTools().catch(() => []),
    ]);

    // Load RAG collections
    state.ragCollections = await api.getRagCollections().catch(() => []);

    // Restore UI state from localStorage
    loadUIState();

    // Apply saved theme
    if (localStorage.getItem('ollama-theme') === 'light') document.body.classList.add('theme-light');

    // Initial render
    renderAll();
    renderRightPanel();
    renderStatusbar();

    // Setup interactions
    setupResizeHandles();
    setupKeyboardShortcuts();
    setupGlobalHandlers();

    // Load chats for any panes with a chatId
    for (const pane of state.panes) {
      if (pane.chatId) {
        try {
          state.loadedChats[pane.chatId] = await api.getChat(pane.chatId);
        } catch {}
      }
    }

    // Check Ollama connection + load models
    await checkConnection();

    // Re-render with data
    renderAll();
    renderRightPanel();

    // Focus active pane's textarea
    setTimeout(() => {
      const ta = document.querySelector(`#pane-${state.activePaneId} .pane-textarea`);
      if (ta) ta.focus();
    }, 100);

  } catch (e) {
    console.error('Init error:', e);
    notify('Initialization error: ' + e.message, 'err');
  }
}

init();
