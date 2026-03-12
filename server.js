import express from 'express';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const CHATS_DIR = join(DATA_DIR, 'chats');
const RAG_DIR = join(DATA_DIR, 'rag');
const PORT = 3131;

// ─── Data Helpers ───────────────────────────────────────────────────────────

async function ensureDataDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(CHATS_DIR, { recursive: true });
  await mkdir(RAG_DIR, { recursive: true });
}

async function readJSON(file, defaultVal = null) {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

async function writeJSON(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

const PROJECTS_FILE = join(DATA_DIR, 'projects.json');
const MCP_SERVERS_FILE = join(DATA_DIR, 'mcp-servers.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const CHAT_INDEX_FILE = join(DATA_DIR, 'chat-index.json');
const RAG_COLLECTIONS_FILE = join(DATA_DIR, 'rag-collections.json');
const PRESETS_FILE = join(DATA_DIR, 'presets.json');
async function getPresets() { return await readJSON(PRESETS_FILE, []); }
async function savePresets(d) { await writeJSON(PRESETS_FILE, d); }

async function getProjects() { return await readJSON(PROJECTS_FILE, []); }
async function saveProjects(d) { await writeJSON(PROJECTS_FILE, d); }
async function getMCPServers() { return await readJSON(MCP_SERVERS_FILE, []); }
async function saveMCPServers(d) { await writeJSON(MCP_SERVERS_FILE, d); }
async function getSettings() {
  return await readJSON(SETTINGS_FILE, {
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
  });
}
async function saveSettings(d) { await writeJSON(SETTINGS_FILE, d); }

// ─── Chat Index ──────────────────────────────────────────────────────────────

async function getChatIndex() { return await readJSON(CHAT_INDEX_FILE, {}); }
async function saveChatIndex(d) { await writeJSON(CHAT_INDEX_FILE, d); }

function resolveChatPath(filePath) {
  if (isAbsolute(filePath)) return filePath;
  return resolve(DATA_DIR, filePath);
}

async function getChat(id) {
  const index = await getChatIndex();
  if (index[id]) {
    const resolved = resolveChatPath(index[id]);
    const chat = await readJSON(resolved, null);
    if (chat) return chat;
  }
  return await readJSON(join(CHATS_DIR, `${id}.json`), null);
}

async function saveChat(chat, projectChatsDir) {
  const index = await getChatIndex();
  let filePath;
  if (projectChatsDir) {
    const absDir = resolveChatPath(projectChatsDir);
    await mkdir(absDir, { recursive: true });
    filePath = join(absDir, `${chat.id}.json`);
    index[chat.id] = filePath;
    await saveChatIndex(index);
  } else if (index[chat.id]) {
    filePath = resolveChatPath(index[chat.id]);
  } else {
    filePath = join(CHATS_DIR, `${chat.id}.json`);
  }
  await writeJSON(filePath, chat);
}

async function deleteChat(id) {
  const index = await getChatIndex();
  if (index[id]) {
    const resolved = resolveChatPath(index[id]);
    try { await unlink(resolved); } catch {}
    delete index[id];
    await saveChatIndex(index);
    return;
  }
  try { await unlink(join(CHATS_DIR, `${id}.json`)); } catch {}
}

async function listChats() {
  try {
    const seen = new Set();
    const chats = [];

    // From index
    const index = await getChatIndex();
    for (const [id, fp] of Object.entries(index)) {
      if (seen.has(id)) continue;
      const resolved = resolveChatPath(fp);
      const chat = await readJSON(resolved, null);
      if (chat) {
        seen.add(id);
        const { messages, ...meta } = chat;
        chats.push({ ...meta, messageCount: messages?.length ?? 0 });
      }
    }

    // From default dir
    const files = await readdir(CHATS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const chat = await readJSON(join(CHATS_DIR, f), null);
      if (chat && !seen.has(chat.id)) {
        seen.add(chat.id);
        const { messages, ...meta } = chat;
        chats.push({ ...meta, messageCount: messages?.length ?? 0 });
      }
    }

    return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch { return []; }
}

// ─── MCP Connection Pool ─────────────────────────────────────────────────────

const mcpConnections = new Map(); // id -> { client, tools }

async function connectMCPServer(server) {
  if (mcpConnections.has(server.id)) {
    await disconnectMCPServer(server.id);
  }
  const client = new Client({ name: 'ollama-tui', version: '2.0.0' }, { capabilities: {} });
  let transport;
  if (server.type === 'stdio') {
    const env = { ...process.env };
    if (server.env) {
      for (const line of server.env.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    const args = server.args ? server.args.split(/\s+/).filter(Boolean) : [];
    transport = new StdioClientTransport({ command: server.command, args, env });
  } else if (server.type === 'sse') {
    transport = new SSEClientTransport(new URL(server.url));
  } else {
    throw new Error(`Unknown MCP server type: ${server.type}`);
  }
  await client.connect(transport);
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools || [];
  mcpConnections.set(server.id, { client, tools, serverName: server.name });
  return tools;
}

async function disconnectMCPServer(id) {
  const conn = mcpConnections.get(id);
  if (conn) {
    try { await conn.client.close(); } catch {}
    mcpConnections.delete(id);
  }
}

function getAllMCPTools() {
  const tools = [];
  for (const [id, conn] of mcpConnections) {
    for (const t of conn.tools) {
      tools.push({ ...t, _mcpServerId: id, _mcpServerName: conn.serverName });
    }
  }
  return tools;
}

// Strip non-essential JSON Schema fields that waste context and confuse smaller models
function cleanToolSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const cleaned = { type: schema.type || 'object' };
  if (schema.properties) {
    cleaned.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      const p = {};
      if (prop.type) p.type = prop.type;
      if (prop.description) p.description = prop.description;
      if (prop.enum) p.enum = prop.enum;
      cleaned.properties[key] = p;
    }
  }
  if (schema.required) cleaned.required = schema.required;
  return cleaned;
}

// Coerce tool arguments to match the expected schema types
// Handles common LLM mistakes: strings for numbers, schema-as-value objects, etc.
function coerceToolArgs(args, schema) {
  if (!schema?.properties || typeof args !== 'object' || !args) return args;
  const coerced = { ...args };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in coerced)) continue;
    let val = coerced[key];

    // LLMs sometimes send schema-like objects as values: {"type":"string","description":"...","value":"actual"}
    if (typeof val === 'object' && val !== null && !Array.isArray(val) && prop.type !== 'object') {
      // Extract the actual value from the schema-like wrapper
      if ('value' in val) val = val.value;
      else if ('enum' in val && Array.isArray(val.enum) && val.enum.length > 0) val = val.enum[0];
      else if (prop.type === 'string' && val.description) val = val.description;
    }

    if (prop.type === 'number' || prop.type === 'integer') {
      if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) val = Number(val);
    } else if (prop.type === 'boolean') {
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
    } else if (prop.type === 'string') {
      if (typeof val !== 'string') val = String(val);
    }

    coerced[key] = val;
  }
  return coerced;
}

async function callMCPTool(name, args) {
  for (const [, conn] of mcpConnections) {
    const found = conn.tools.find(t => t.name === name);
    if (found) {
      // Coerce argument types based on tool's input schema
      const coercedArgs = coerceToolArgs(args, found.inputSchema);
      const result = await conn.client.callTool({ name, arguments: coercedArgs });
      const content = result.content || [];
      const text = content.map(c => c.text || JSON.stringify(c)).join('\n');
      if (result.isError) {
        throw new Error(text || 'Tool returned an error');
      }
      return text;
    }
  }
  throw new Error(`MCP tool not found: ${name}`);
}

// ─── Built-in Tools ──────────────────────────────────────────────────────────

const BUILTIN_TOOLS = [
  {
    name: 'web_fetch',
    description: 'Fetch the content of a URL and return it as text.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate a mathematical expression safely.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'Math expression to evaluate' } },
      required: ['expression'],
    },
  },
  {
    name: 'current_datetime',
    description: 'Return the current date and time.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo, SearXNG, Brave, or Tavily and return results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        engine: { type: 'string', description: 'Engine to use: ddg, searxng, brave, or tavily', enum: ['ddg', 'searxng', 'brave', 'tavily'] },
      },
      required: ['query'],
    },
  },
];

async function callBuiltinTool(name, args, settings = {}) {
  if (name === 'web_fetch') {
    const { url } = args;
    const resp = await fetch(url, { headers: { 'User-Agent': 'OllamaTUI/2.0' } });
    const html = await resp.text();
    // Strip HTML tags for a text summary
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return text;
  }
  if (name === 'calculator') {
    const { expression } = args;
    try {
      // Safe math eval - only allow numbers and operators
      if (!/^[\d\s+\-*/().,^%eE]+$/.test(expression)) throw new Error('Invalid expression');
      const result = Function(`"use strict"; return (${expression})`)();
      return String(result);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }
  if (name === 'current_datetime') {
    return new Date().toISOString();
  }
  if (name === 'web_search') {
    return await doWebSearch(args.query, args.engine || settings.searchEngine || 'ddg', settings);
  }
  throw new Error(`Unknown built-in tool: ${name}`);
}

async function doWebSearch(query, engine = 'ddg', settings = {}) {
  try {
    if (engine === 'searxng' && settings.searxngUrl) {
      const url = `${settings.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'OllamaTUI/2.0' } });
      const json = await resp.json();
      const results = (json.results || []).slice(0, 5);
      return results.map(r => `${r.title}\n${r.url}\n${r.content || ''}`).join('\n\n');
    } else if (engine === 'brave' && settings.braveApiKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'OllamaTUI/2.0',
          'X-Subscription-Token': settings.braveApiKey,
          'Accept': 'application/json',
        },
      });
      const json = await resp.json();
      const results = (json.web?.results || []).slice(0, 5);
      return results.map(r => `${r.title}\n${r.url}\n${r.description || ''}`).join('\n\n') || 'No results found.';
    } else if (engine === 'tavily' && settings.tavilyApiKey) {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: settings.tavilyApiKey, query, max_results: 5 }),
      });
      const json = await resp.json();
      const results = (json.results || []).slice(0, 5);
      return results.map(r => `${r.title}\n${r.url}\n${r.content || ''}`).join('\n\n') || 'No results found.';
    } else {
      // DuckDuckGo Instant Answer API — note: DDG blocks full HTML scraping server-side.
      // This API returns factual answers for many queries but no ranked link lists.
      // For real web results, use Brave or Tavily (both have free API tiers).
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0' },
      });
      if (!resp.ok) return `DDG search unavailable (HTTP ${resp.status}). Consider using Brave or Tavily search instead.`;
      const json = await resp.json();

      const parts = [];

      // Direct answer (calculator, definitions, etc.)
      if (json.Answer) parts.push(`Answer: ${json.Answer}`);

      // Abstract from a knowledge source
      if (json.AbstractText) {
        const src = json.AbstractSource ? ` (${json.AbstractSource})` : '';
        parts.push(`${json.AbstractText}${src}\n${json.AbstractURL || ''}`);
      }

      // Direct results (e.g. software pages)
      if (json.Results?.length) {
        for (const r of json.Results.slice(0, 3)) {
          if (r.Text) parts.push(`${r.Text}\n${r.FirstURL || ''}`);
        }
      }

      // Related topics
      if (json.RelatedTopics?.length) {
        const topics = json.RelatedTopics
          .filter(t => t.Text)
          .slice(0, 5 - parts.length);
        for (const t of topics) {
          parts.push(`- ${t.Text}${t.FirstURL ? '\n  ' + t.FirstURL : ''}`);
        }
      }

      if (parts.length === 0) {
        return `DDG found no instant answer for: "${query}"\n\nNote: DuckDuckGo's free API only returns factual answers, not full web results. For real search results, add a Brave or Tavily API key in Settings → Search.`;
      }

      return parts.join('\n\n');
    }
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

// ─── RAG Helpers ─────────────────────────────────────────────────────────────

async function getRagCollections() {
  return await readJSON(RAG_COLLECTIONS_FILE, []);
}

async function saveRagCollections(d) {
  await writeJSON(RAG_COLLECTIONS_FILE, d);
}

async function getRagCollection(id) {
  return await readJSON(join(RAG_DIR, `${id}.json`), null);
}

async function saveRagCollection(data) {
  await writeJSON(join(RAG_DIR, `${data.id}.json`), data);
}

function chunkText(text, size = 500, overlap = 50) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += size - overlap;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function embedText(text, model, ollamaUrl) {
  // Try newer /api/embed endpoint first, fall back to /api/embeddings
  try {
    const resp = await fetch(`${ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    if (resp.ok) {
      const json = await resp.json();
      // /api/embed returns { embeddings: [[...]] }
      if (json.embeddings?.[0]?.length > 0) return json.embeddings[0];
    }
  } catch {}

  // Fallback to legacy /api/embeddings
  const resp = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Embedding failed (${resp.status}): ${errText}`);
  }
  const json = await resp.json();
  if (!json.embedding || json.embedding.length === 0) {
    throw new Error(`Embedding returned empty result for model "${model}"`);
  }
  return json.embedding;
}

// ─── Ollama Helpers ──────────────────────────────────────────────────────────

async function getOllamaUrl() {
  const s = await getSettings();
  return s.ollamaUrl || 'http://localhost:11434';
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Projects ──

app.get('/api/projects', async (req, res) => {
  res.json(await getProjects());
});
app.post('/api/projects', async (req, res) => {
  const projects = await getProjects();
  const project = { id: uuidv4(), name: req.body.name || 'New Project', color: req.body.color || '#00ff88', createdAt: Date.now(), ...req.body };
  project.id = uuidv4();
  projects.push(project);
  await saveProjects(projects);
  res.json(project);
});
app.put('/api/projects/:id', async (req, res) => {
  const projects = await getProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  projects[idx] = { ...projects[idx], ...req.body, id: req.params.id };
  await saveProjects(projects);
  res.json(projects[idx]);
});
app.delete('/api/projects/:id', async (req, res) => {
  let projects = await getProjects();
  projects = projects.filter(p => p.id !== req.params.id);
  await saveProjects(projects);
  res.json({ ok: true });
});

// ── Chats ──

app.get('/api/chats', async (req, res) => {
  const chats = await listChats();
  if (req.query.projectId) {
    return res.json(chats.filter(c => c.projectId === req.query.projectId));
  }
  res.json(chats);
});
app.get('/api/chats/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const allChats = await listChats();
    const results = [];
    for (const meta of allChats.slice(0, 100)) { // limit to 100 most recent
      const chat = await getChat(meta.id);
      if (!chat) continue;
      for (let i = 0; i < (chat.messages || []).length; i++) {
        const m = chat.messages[i];
        if ((m.content || '').toLowerCase().includes(q)) {
          const start = Math.max(0, (m.content || '').toLowerCase().indexOf(q) - 40);
          const excerpt = (m.content || '').slice(start, start + 120);
          results.push({ chatId: chat.id, chatName: chat.name, messageIndex: i, role: m.role, excerpt });
          if (results.length >= 50) break;
        }
      }
      if (results.length >= 50) break;
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chats/:id', async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
});
app.post('/api/chats', async (req, res) => {
  const chat = {
    id: uuidv4(),
    name: req.body.name || 'New Chat',
    projectId: req.body.projectId || null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...req.body,
  };
  chat.id = uuidv4();
  chat.messages = req.body.messages || [];
  // Find project chatsDir if any
  let projectChatsDir = null;
  if (chat.projectId) {
    const projects = await getProjects();
    const proj = projects.find(p => p.id === chat.projectId);
    if (proj?.chatsDir) projectChatsDir = proj.chatsDir;
  }
  await saveChat(chat, projectChatsDir);
  res.json(chat);
});
app.put('/api/chats/:id', async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const updated = { ...chat, ...req.body, id: req.params.id, updatedAt: Date.now() };
  await saveChat(updated);
  res.json(updated);
});
app.delete('/api/chats/:id', async (req, res) => {
  await deleteChat(req.params.id);
  res.json({ ok: true });
});

// ── MCP Servers ──

app.get('/api/mcp/servers', async (req, res) => {
  const servers = await getMCPServers();
  const result = servers.map(s => ({
    ...s,
    connected: mcpConnections.has(s.id),
    toolCount: mcpConnections.has(s.id) ? mcpConnections.get(s.id).tools.length : 0,
  }));
  res.json(result);
});
app.post('/api/mcp/servers', async (req, res) => {
  const servers = await getMCPServers();
  const server = { id: uuidv4(), ...req.body };
  servers.push(server);
  await saveMCPServers(servers);
  res.json(server);
});
app.put('/api/mcp/servers/:id', async (req, res) => {
  const servers = await getMCPServers();
  const idx = servers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  servers[idx] = { ...servers[idx], ...req.body, id: req.params.id };
  await saveMCPServers(servers);
  res.json(servers[idx]);
});
app.delete('/api/mcp/servers/:id', async (req, res) => {
  await disconnectMCPServer(req.params.id);
  let servers = await getMCPServers();
  servers = servers.filter(s => s.id !== req.params.id);
  await saveMCPServers(servers);
  res.json({ ok: true });
});
app.post('/api/mcp/servers/:id/connect', async (req, res) => {
  const servers = await getMCPServers();
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const tools = await connectMCPServer(server);
    res.json({ ok: true, toolCount: tools.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/mcp/servers/:id/disconnect', async (req, res) => {
  await disconnectMCPServer(req.params.id);
  res.json({ ok: true });
});
app.get('/api/mcp/tools', (req, res) => {
  res.json(getAllMCPTools());
});

// ── Settings ──

app.get('/api/settings', async (req, res) => {
  res.json(await getSettings());
});
app.put('/api/settings', async (req, res) => {
  const current = await getSettings();
  const updated = { ...current, ...req.body };
  await saveSettings(updated);
  res.json(updated);
});

// ── Presets ──

app.get('/api/presets', async (req, res) => {
  res.json(await getPresets());
});
app.post('/api/presets', async (req, res) => {
  const presets = await getPresets();
  const preset = { id: uuidv4(), name: req.body.name || 'Preset', ...req.body };
  preset.id = uuidv4();
  presets.push(preset);
  await savePresets(presets);
  res.json(preset);
});
app.delete('/api/presets/:id', async (req, res) => {
  let presets = await getPresets();
  presets = presets.filter(p => p.id !== req.params.id);
  await savePresets(presets);
  res.json({ ok: true });
});

// ── Ollama Proxy ──

app.get('/api/ollama/models', async (req, res) => {
  try {
    const base = await getOllamaUrl();
    const resp = await fetch(`${base}/api/tags`);
    const json = await resp.json();
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.delete('/api/ollama/models/:name', async (req, res) => {
  try {
    const base = await getOllamaUrl();
    const resp = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.params.name }),
    });
    res.status(resp.status).json({ ok: resp.ok });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.post('/api/ollama/pull', async (req, res) => {
  try {
    const base = await getOllamaUrl();
    const resp = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.body.name, stream: true }),
    });
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    const reader = resp.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    };
    await pump();
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Web Search ──

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q' });
  const settings = await getSettings();
  const result = await doWebSearch(q, settings.searchEngine || 'ddg', settings);
  res.json({ result });
});

// ── File Upload ──

app.post('/api/upload', async (req, res) => {
  const { filename, content: base64Content, mimeType } = req.body;
  if (!base64Content) return res.status(400).json({ error: 'Missing content' });
  try {
    let text = '';
    const buf = Buffer.from(base64Content, 'base64');

    if (mimeType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
      // Simple PDF text extraction - read raw bytes looking for text streams
      // This is a basic fallback; for production use pdf-parse npm package
      text = buf.toString('latin1').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
      if (text.length < 100) text = '[PDF content could not be extracted. Install pdf-parse for better support.]';
    } else {
      // Text files: txt, md, csv, json, code files
      text = buf.toString('utf8').slice(0, 12000);
    }

    res.json({ text, filename: filename || 'file', charCount: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tools Test ──

app.post('/api/tools/test', async (req, res) => {
  const { name, args } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const settings = await getSettings();
  try {
    const builtinNames = BUILTIN_TOOLS.map(t => t.name);
    let result;
    if (builtinNames.includes(name)) {
      result = await callBuiltinTool(name, args || {}, settings);
    } else {
      result = await callMCPTool(name, args || {});
    }
    res.json({ result });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── RAG Collections ──

app.get('/api/rag/collections', async (req, res) => {
  res.json(await getRagCollections());
});

app.get('/api/rag/collections/:id', async (req, res) => {
  const colData = await getRagCollection(req.params.id);
  if (!colData) return res.status(404).json({ error: 'Collection not found' });
  // Return metadata + document list (without full content/embeddings to keep response small)
  const docs = (colData.documents || []).map(d => ({
    id: d.id,
    title: d.title,
    chunkCount: d.chunks?.length || 0,
    createdAt: d.createdAt,
  }));
  res.json({ ...colData, documents: docs });
});

app.post('/api/rag/collections', async (req, res) => {
  const collections = await getRagCollections();
  const col = {
    id: uuidv4(),
    name: req.body.name || 'New Collection',
    description: req.body.description || '',
    embeddingModel: req.body.embeddingModel || '',
    createdAt: Date.now(),
  };
  collections.push(col);
  await saveRagCollections(collections);
  // Create empty collection file
  await saveRagCollection({ ...col, documents: [] });
  res.json(col);
});

app.put('/api/rag/collections/:id', async (req, res) => {
  const collections = await getRagCollections();
  const idx = collections.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  collections[idx] = { ...collections[idx], ...req.body, id: req.params.id };
  await saveRagCollections(collections);
  // Update collection file metadata too
  const colData = await getRagCollection(req.params.id);
  if (colData) {
    await saveRagCollection({ ...colData, ...req.body, id: req.params.id });
  }
  res.json(collections[idx]);
});

app.delete('/api/rag/collections/:id', async (req, res) => {
  let collections = await getRagCollections();
  collections = collections.filter(c => c.id !== req.params.id);
  await saveRagCollections(collections);
  try { await unlink(join(RAG_DIR, `${req.params.id}.json`)); } catch {}
  res.json({ ok: true });
});

app.post('/api/rag/collections/:id/documents', async (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });
  const colData = await getRagCollection(req.params.id);
  if (!colData) return res.status(404).json({ error: 'Collection not found' });
  const settings = await getSettings();
  const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
  const embModel = colData.embeddingModel || settings.ragEmbeddingModel || 'nomic-embed-text';
  const textChunks = chunkText(content);
  const chunks = [];
  let embedErrors = 0;
  for (const text of textChunks) {
    try {
      const embedding = await embedText(text, embModel, ollamaUrl);
      chunks.push({ text, embedding });
    } catch (e) {
      console.error('Embedding error:', e.message);
      embedErrors++;
      chunks.push({ text, embedding: [] });
    }
  }
  if (embedErrors === textChunks.length) {
    return res.status(500).json({ error: `All ${embedErrors} chunks failed to embed. Check that model "${embModel}" is available.` });
  }
  const doc = {
    id: uuidv4(),
    title: title || 'Untitled',
    content,
    chunks,
    createdAt: Date.now(),
  };
  colData.documents = colData.documents || [];
  colData.documents.push(doc);
  await saveRagCollection(colData);
  const result = { id: doc.id, title: doc.title, chunkCount: chunks.length };
  if (embedErrors > 0) result.warning = `${embedErrors} of ${textChunks.length} chunks failed to embed`;
  res.json(result);
});

app.delete('/api/rag/collections/:id/documents/:docId', async (req, res) => {
  const colData = await getRagCollection(req.params.id);
  if (!colData) return res.status(404).json({ error: 'Collection not found' });
  colData.documents = (colData.documents || []).filter(d => d.id !== req.params.docId);
  await saveRagCollection(colData);
  res.json({ ok: true });
});

app.post('/api/rag/collections/:id/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const colData = await getRagCollection(req.params.id);
  if (!colData) return res.status(404).json({ error: 'Collection not found' });
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'OllamaTUI/2.0' } });
    if (!resp.ok) return res.status(400).json({ error: `Failed to fetch URL: HTTP ${resp.status}` });

    // Reject binary content (PDFs, images, etc.)
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream') ||
        contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('video/')) {
      return res.status(400).json({ error: `Cannot process binary content (${contentType.split(';')[0]}). Only HTML and text URLs are supported.` });
    }

    const html = await resp.text();

    // Detect binary content that slipped through (e.g. missing content-type)
    const binaryRatio = (html.slice(0, 1000).match(/[\x00-\x08\x0e-\x1f]/g) || []).length / Math.min(html.length, 1000);
    if (binaryRatio > 0.1) {
      return res.status(400).json({ error: 'Content appears to be binary (PDF, image, etc). Only HTML and text URLs are supported.' });
    }

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    if (!text || text.length < 50) return res.status(400).json({ error: 'Could not extract text from URL' });

    const settings = await getSettings();
    const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
    const embModel = colData.embeddingModel || settings.ragEmbeddingModel || 'nomic-embed-text';
    const textChunks = chunkText(text);
    const chunks = [];
    let embedErrors = 0;
    for (const t of textChunks) {
      try {
        const embedding = await embedText(t, embModel, ollamaUrl);
        chunks.push({ text: t, embedding });
      } catch (e) {
        console.error('Embedding error (URL):', e.message);
        embedErrors++;
        chunks.push({ text: t, embedding: [] });
      }
    }
    if (embedErrors === textChunks.length) {
      return res.status(500).json({ error: `All ${embedErrors} chunks failed to embed. Check that model "${embModel}" is available.` });
    }
    const doc = { id: uuidv4(), title: url, content: text, chunks, createdAt: Date.now() };
    colData.documents = colData.documents || [];
    colData.documents.push(doc);
    await saveRagCollection(colData);
    const result = { id: doc.id, title: doc.title, chunkCount: chunks.length };
    if (embedErrors > 0) result.warning = `${embedErrors} of ${textChunks.length} chunks failed to embed`;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rag/collections/:id/query', async (req, res) => {
  const { query, topK = 3 } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const colData = await getRagCollection(req.params.id);
  if (!colData) return res.status(404).json({ error: 'Collection not found' });
  const settings = await getSettings();
  const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
  const embModel = colData.embeddingModel || settings.ragEmbeddingModel || 'nomic-embed-text';
  let queryEmbedding;
  try {
    queryEmbedding = await embedText(query, embModel, ollamaUrl);
  } catch (e) {
    return res.status(500).json({ error: `Embedding error: ${e.message}` });
  }
  const scored = [];
  for (const doc of (colData.documents || [])) {
    for (const chunk of (doc.chunks || [])) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      scored.push({ text: chunk.text, score, docTitle: doc.title, docId: doc.id });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  res.json(scored.slice(0, topK));
});

// ── Arena Agent Runner ──

async function runAgentTurn(agentConfig, messages, options = {}) {
  const {
    ollamaUrl,
    settings,
    tools = [],
    onDelta,
    onToolCallStart,
    onToolCallResult,
    maxToolIterations = 8,
    outputFormat, // 'json' for judge/orchestrator
  } = options;

  const model = agentConfig.model;
  const ollamaMessages = [];
  if (agentConfig.systemPrompt) ollamaMessages.push({ role: 'system', content: agentConfig.systemPrompt });
  ollamaMessages.push(...messages);

  let assistantContent = '';
  let iterations = 0;
  const contextMsgs = [...ollamaMessages];

  while (iterations < maxToolIterations) {
    iterations++;
    const body = {
      model,
      messages: contextMsgs,
      stream: true,
      options: {
        temperature: settings.temperature ?? 0.7,
        top_p: settings.top_p ?? 0.9,
        top_k: settings.top_k ?? 40,
        num_predict: settings.max_tokens ?? 2048,
        repeat_penalty: settings.repeat_penalty ?? 1.1,
      },
    };
    if (tools.length > 0) body.tools = tools;
    if (outputFormat === 'json') body.format = 'json';

    let ollamaResp;
    try {
      ollamaResp = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Ollama connection error: ${e.message}`);
    }
    if (!ollamaResp.ok) {
      const errText = await ollamaResp.text();
      throw new Error(`Ollama error ${ollamaResp.status}: ${errText}`);
    }

    const reader = ollamaResp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentToolCalls = [];
    let isDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.message?.content) {
          assistantContent += obj.message.content;
          onDelta?.(obj.message.content);
        }
        if (obj.message?.tool_calls?.length) {
          for (const tc of obj.message.tool_calls) {
            const existing = currentToolCalls.find(c => (c.function?.name || c.name) === (tc.function?.name || tc.name));
            if (!existing) currentToolCalls.push(tc);
          }
        }
        if (obj.done) isDone = true;
      }
    }
    if (buf.trim()) {
      try {
        const obj = JSON.parse(buf);
        if (obj.message?.tool_calls) {
          for (const tc of obj.message.tool_calls) {
            const existing = currentToolCalls.find(c => (c.function?.name || c.name) === (tc.function?.name || tc.name));
            if (!existing) currentToolCalls.push(tc);
          }
        }
        if (obj.done) isDone = true;
      } catch {}
    }

    if (currentToolCalls.length === 0 || !isDone) break;

    // Process tool calls
    contextMsgs.push({ role: 'assistant', content: assistantContent || null, tool_calls: currentToolCalls });

    for (const tc of currentToolCalls) {
      const fnName = tc.function?.name || tc.name;
      const fnArgs = tc.function?.arguments || tc.arguments || {};
      const callId = tc.id || uuidv4();
      onToolCallStart?.({ id: callId, name: fnName, args: fnArgs });
      let result = '';
      try {
        const builtinNames = BUILTIN_TOOLS.map(t => t.name);
        if (builtinNames.includes(fnName)) {
          result = await callBuiltinTool(fnName, fnArgs, settings);
        } else {
          result = await callMCPTool(fnName, fnArgs);
        }
      } catch (e) { result = `Tool error: ${e.message}. You MUST retry the tool call with corrected arguments.`; }
      onToolCallResult?.({ id: callId, name: fnName, result });
      contextMsgs.push({ role: 'tool', content: String(result), tool_call_id: callId });
    }
    assistantContent = '';
  }

  return assistantContent;
}

// ── Arena ──

function parseJsonOutput(content) {
  const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}

function buildJudgePrompt(workers, results, criteria) {
  const criterion = criteria || 'accuracy, clarity, and completeness';
  let prompt = `Criteria: ${criterion}\n\nResponses to evaluate:\n\n`;
  workers.forEach((w, i) => {
    prompt += `=== ${w.name} ===\n${results[i]}\n\n`;
  });
  prompt += `Respond with ONLY valid JSON in this exact format, no other text:\n{"scores":[{"agent":"name","score":7.5,"reasoning":"..."}],"winner":"name","summary":"..."}`;
  return prompt;
}

function buildOrchestratorSystemPrompt(workers) {
  return `You are an orchestration agent. Break down the user's task and delegate to specialized workers.

Available workers:
${workers.map(w => `- "${w.name}": ${w.systemPrompt || 'General assistant'}`).join('\n')}

At each step, respond with ONLY a JSON object in one of these formats:

To delegate to a worker:
{"action":"delegate","worker":"WorkerName","task":"Full task description with all context needed"}

To produce the final answer after workers have completed their tasks:
{"action":"finalize","answer":"Your complete synthesized answer here"}

No text outside the JSON. No markdown. Pure JSON only.`;
}

function buildOrchestratorPrompt(initialPrompt, context, step) {
  let prompt = `Task: ${initialPrompt}\n\n`;
  if (context.length === 0) {
    prompt += `Step 1: You have no results yet. Determine the first delegation needed.`;
  } else {
    prompt += `Results gathered so far:\n`;
    for (const c of context) {
      prompt += `\n[${c.worker}] Task: "${c.task}"\nResult: ${c.result}\n`;
    }
    prompt += `\nStep ${step}: Based on the above, what is the next action? Delegate to another worker or finalize if you have enough information.`;
  }
  return prompt;
}

app.post('/api/arena/stream', async (req, res) => {
  const { agents, mode = 'sequential', maxTurns = 3, modeConfig = {} } = req.body;
  const initialPrompt = req.body.initialPrompt || req.body.prompt;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const settings = await getSettings();
    const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';

    if (!agents || agents.length === 0) {
      sendEvent('error', { message: 'No agents defined' });
      res.end();
      return;
    }

    const agentColors = ['green', 'cyan', 'orange', 'yellow'];

    // ── Sequential (legacy) ──
    if (mode === 'sequential') {
      let lastContent = initialPrompt;
      for (let t = 0; t < maxTurns; t++) {
        const agent = agents[t % agents.length];
        sendEvent('agent_start', { agentName: agent.name, model: agent.model, turn: t + 1 });
        try {
          lastContent = await runAgentTurn(agent, [{ role: 'user', content: lastContent }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: agent.name, text }),
          });
          sendEvent('agent_done', { agentName: agent.name, content: lastContent });
        } catch (e) {
          sendEvent('error', { message: `${agent.name}: ${e.message}` });
          break;
        }
        if (!lastContent) break;
      }
    }

    // ── Parallel (legacy) ──
    else if (mode === 'parallel') {
      await Promise.all(agents.map(async (agent) => {
        sendEvent('agent_start', { agentName: agent.name, model: agent.model, turn: 1 });
        try {
          const content = await runAgentTurn(agent, [{ role: 'user', content: initialPrompt }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: agent.name, text }),
          });
          sendEvent('agent_done', { agentName: agent.name, content });
        } catch (e) {
          sendEvent('error', { message: `${agent.name}: ${e.message}` });
        }
      }));
    }

    // ── Judge Mode ──
    else if (mode === 'judge') {
      const judgeAgentName = modeConfig.judgeAgentName;
      const judgeAgent = agents.find(a => a.name === judgeAgentName || a.role === 'judge');
      const workers = agents.filter(a => a !== judgeAgent);

      if (!judgeAgent) {
        sendEvent('error', { message: 'Judge mode requires a judge agent. Set role to "judge" on one agent.' });
        res.end();
        return;
      }

      // Run workers in parallel
      const results = await Promise.all(workers.map(async (agent) => {
        sendEvent('agent_start', { agentName: agent.name, model: agent.model, turn: 1, role: 'worker' });
        try {
          const content = await runAgentTurn(agent, [{ role: 'user', content: initialPrompt }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: agent.name, text }),
          });
          sendEvent('agent_done', { agentName: agent.name, content });
          return content;
        } catch (e) {
          sendEvent('error', { message: `${agent.name}: ${e.message}` });
          return '';
        }
      }));

      // Run judge
      const judgeSystemPrompt = 'You are a strict evaluator. Respond with ONLY valid JSON, no markdown, no preamble, no explanation outside the JSON object.';
      const judgeAgentWithPrompt = { ...judgeAgent, systemPrompt: judgeSystemPrompt };
      const judgePrompt = `Task that was given:\n"${initialPrompt}"\n\n` + buildJudgePrompt(workers, results, modeConfig.judgeCriteria);

      sendEvent('agent_start', { agentName: judgeAgent.name, model: judgeAgent.model, turn: 2, role: 'judge' });
      let judgeRaw = '';
      try {
        judgeRaw = await runAgentTurn(judgeAgentWithPrompt, [{ role: 'user', content: judgePrompt }], {
          ollamaUrl, settings,
          outputFormat: 'json',
          onDelta: (text) => sendEvent('delta', { agentName: judgeAgent.name, text }),
        });
      } catch (e) {
        sendEvent('error', { message: `Judge error: ${e.message}` });
      }

      // Parse and emit structured verdict
      const verdict = parseJsonOutput(judgeRaw);
      if (verdict?.scores) {
        sendEvent('judge_result', verdict);
      } else {
        sendEvent('judge_result', { scores: [], winner: 'Parse failed', summary: judgeRaw });
      }
    }

    // ── Debate Mode ──
    else if (mode === 'debate') {
      const rounds = modeConfig.rounds || 3;
      const positions = modeConfig.debatePositions || ['For', 'Against'];
      const judgeAgent = agents.find(a => a.role === 'judge');
      const debaters = agents.filter(a => a.role !== 'judge');

      if (debaters.length < 2) {
        sendEvent('error', { message: 'Debate mode requires at least 2 debater agents.' });
        res.end();
        return;
      }

      const lastResponses = {};

      for (let round = 1; round <= rounds; round++) {
        sendEvent('round_start', { round, totalRounds: rounds });
        for (let i = 0; i < debaters.length; i++) {
          const agent = debaters[i];
          const position = positions[i % positions.length];
          const opponent = debaters[(i + 1) % debaters.length];

          let userContent = `Topic: ${initialPrompt}\n\nYou are arguing the position: "${position}"`;
          if (round > 1 && lastResponses[opponent.name]) {
            userContent += `\n\nYour opponent (${opponent.name}) just argued:\n${lastResponses[opponent.name]}\n\nNow rebut their argument while reinforcing your position. Be specific and direct.`;
          } else if (round === 1) {
            userContent += `\n\nMake your opening argument. Be clear, specific, and persuasive.`;
          }

          sendEvent('agent_start', { agentName: agent.name, model: agent.model, turn: round, role: 'debater', position });
          try {
            const content = await runAgentTurn(agent, [{ role: 'user', content: userContent }], {
              ollamaUrl, settings,
              onDelta: (text) => sendEvent('delta', { agentName: agent.name, text }),
            });
            lastResponses[agent.name] = content;
            sendEvent('agent_done', { agentName: agent.name, content });
          } catch (e) {
            sendEvent('error', { message: `${agent.name}: ${e.message}` });
          }
        }
      }

      // Judge summary if present
      if (judgeAgent) {
        const transcript = debaters.map(d => `${d.name} [${positions[debaters.indexOf(d) % positions.length]}]:\n${lastResponses[d.name] || '(no response)'}`).join('\n\n---\n\n');
        const summaryPrompt = `Topic: "${initialPrompt}"\n\nDebate transcript:\n\n${transcript}\n\nSummarize the key arguments from each side, identify the strongest points, and declare which argument was most compelling and why.`;

        sendEvent('agent_start', { agentName: judgeAgent.name, model: judgeAgent.model, turn: rounds + 1, role: 'judge' });
        try {
          const summary = await runAgentTurn(judgeAgent, [{ role: 'user', content: summaryPrompt }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: judgeAgent.name, text }),
          });
          sendEvent('agent_done', { agentName: judgeAgent.name, content: summary });
        } catch (e) {
          sendEvent('error', { message: `Judge error: ${e.message}` });
        }
      }
    }

    // ── Refinement Mode ──
    else if (mode === 'refinement') {
      const cycles = modeConfig.cycles || 2;
      const writerAgent = agents.find(a => a.role === 'writer') || agents[0];
      const criticAgent = agents.find(a => a.role === 'critic') || agents[1];

      if (!writerAgent || !criticAgent) {
        sendEvent('error', { message: 'Refinement mode requires writer and critic agents.' });
        res.end();
        return;
      }

      let currentDraft = '';
      let lastCritique = '';

      for (let cycle = 1; cycle <= cycles; cycle++) {
        // Writer turn
        let writerPrompt;
        if (cycle === 1) {
          writerPrompt = initialPrompt;
        } else {
          writerPrompt = `Original task: ${initialPrompt}\n\nYour previous version:\n${currentDraft}\n\nCritic's feedback:\n${lastCritique}\n\nProduce a revised version that directly addresses the feedback while keeping what worked well.`;
        }

        sendEvent('agent_start', { agentName: writerAgent.name, model: writerAgent.model, turn: cycle, role: 'writer', cycle });
        try {
          currentDraft = await runAgentTurn(writerAgent, [{ role: 'user', content: writerPrompt }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: writerAgent.name, text }),
          });
          sendEvent('agent_done', { agentName: writerAgent.name, content: currentDraft });
        } catch (e) {
          sendEvent('error', { message: `Writer error: ${e.message}` });
          break;
        }

        // Critic turn
        const criticPrompt = `Review the following and provide specific, numbered, actionable critique. Focus on what could be improved, not just praise:\n\n${currentDraft}`;
        sendEvent('agent_start', { agentName: criticAgent.name, model: criticAgent.model, turn: cycle, role: 'critic', cycle });
        try {
          lastCritique = await runAgentTurn(criticAgent, [{ role: 'user', content: criticPrompt }], {
            ollamaUrl, settings,
            onDelta: (text) => sendEvent('delta', { agentName: criticAgent.name, text }),
          });
          sendEvent('agent_done', { agentName: criticAgent.name, content: lastCritique });
        } catch (e) {
          sendEvent('error', { message: `Critic error: ${e.message}` });
          break;
        }

        sendEvent('refinement_cycle_done', { cycle, cycles });
      }

      sendEvent('refinement_final', { finalDraft: currentDraft });
    }

    // ── Orchestrated Pipeline ──
    else if (mode === 'orchestrated') {
      const orchestratorAgent = agents.find(a => a.role === 'orchestrator');
      const workerAgents = agents.filter(a => a.role === 'worker');
      const maxSteps = modeConfig.maxSteps || 8;

      if (!orchestratorAgent) {
        sendEvent('error', { message: 'Orchestrated mode requires an orchestrator agent.' });
        res.end();
        return;
      }
      if (workerAgents.length === 0) {
        sendEvent('error', { message: 'Orchestrated mode requires at least one worker agent.' });
        res.end();
        return;
      }

      const orchSystemPrompt = buildOrchestratorSystemPrompt(workerAgents);
      const orchAgent = { ...orchestratorAgent, systemPrompt: orchSystemPrompt };

      const workerTools = workerAgents.some(w => w.enableTools) ? BUILTIN_TOOLS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })) : [];

      const accumulatedContext = [];
      let step = 0;

      while (step < maxSteps) {
        step++;
        sendEvent('orchestrator_thinking', { step });

        const orchPrompt = buildOrchestratorPrompt(initialPrompt, accumulatedContext, step);
        let orchRaw = '';
        try {
          orchRaw = await runAgentTurn(orchAgent, [{ role: 'user', content: orchPrompt }], {
            ollamaUrl, settings,
            outputFormat: 'json',
            onDelta: (text) => sendEvent('orchestrator_delta', { text, step }),
          });
        } catch (e) {
          sendEvent('error', { message: `Orchestrator error at step ${step}: ${e.message}` });
          break;
        }

        let command = parseJsonOutput(orchRaw);

        // Retry once if parse failed
        if (!command) {
          try {
            const retryPrompt = `${orchPrompt}\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY the JSON object, nothing else.`;
            orchRaw = await runAgentTurn(orchAgent, [{ role: 'user', content: retryPrompt }], {
              ollamaUrl, settings, outputFormat: 'json',
            });
            command = parseJsonOutput(orchRaw);
          } catch {}
        }

        if (!command) {
          sendEvent('error', { message: `Orchestrator produced invalid JSON at step ${step}` });
          break;
        }

        sendEvent('orchestrator_command', { step, action: command.action, worker: command.worker, task: command.task });

        if (command.action === 'finalize') {
          sendEvent('orchestrator_final', { answer: command.answer, steps: step });
          break;
        }

        if (command.action === 'delegate') {
          const targetWorker = workerAgents.find(w => w.name === command.worker);
          if (!targetWorker) {
            accumulatedContext.push({
              worker: command.worker,
              task: command.task,
              result: `ERROR: Worker "${command.worker}" not found. Available workers: ${workerAgents.map(w => w.name).join(', ')}`,
            });
            continue;
          }

          sendEvent('worker_start', { worker: targetWorker.name, model: targetWorker.model, task: command.task, step });
          try {
            const workerResult = await runAgentTurn(targetWorker, [{ role: 'user', content: command.task }], {
              ollamaUrl, settings,
              tools: targetWorker.enableTools ? workerTools : [],
              onDelta: (text) => sendEvent('worker_delta', { worker: targetWorker.name, text, step }),
              onToolCallStart: (data) => sendEvent('worker_tool_call', { worker: targetWorker.name, ...data, step }),
              onToolCallResult: (data) => sendEvent('worker_tool_result', { worker: targetWorker.name, ...data, step }),
            });
            sendEvent('worker_done', { worker: targetWorker.name, result: workerResult, step });
            accumulatedContext.push({ worker: targetWorker.name, task: command.task, result: workerResult });
          } catch (e) {
            const errMsg = `Error: ${e.message}`;
            sendEvent('worker_done', { worker: targetWorker.name, result: errMsg, step });
            accumulatedContext.push({ worker: targetWorker.name, task: command.task, result: errMsg });
          }
        }
      }

      if (step >= maxSteps && !accumulatedContext.find(c => c.action === 'finalize')) {
        sendEvent('error', { message: `Orchestration reached max steps (${maxSteps}) without finalizing.` });
      }
    }

    sendEvent('done', {});
    res.end();
  } catch (e) {
    console.error('Arena stream error:', e);
    try { sendEvent('error', { message: e.message }); } catch {}
    res.end();
  }
});

app.post('/api/arena/save-as-chat', async (req, res) => {
  const { arenaMode, prompt, messages, projectId } = req.body;
  if (!messages || messages.length === 0) return res.status(400).json({ error: 'No messages' });
  const chat = {
    id: uuidv4(),
    name: `Arena [${arenaMode}]: ${(prompt || '').slice(0, 40)}`,
    projectId: projectId || null,
    messages,
    arenaTranscript: true,
    arenaMode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  let projectChatsDir = null;
  if (projectId) {
    const projects = await getProjects();
    const proj = projects.find(p => p.id === projectId);
    if (proj?.chatsDir) projectChatsDir = proj.chatsDir;
  }
  await saveChat(chat, projectChatsDir);
  res.json({ id: chat.id, name: chat.name });
});

// ── Streaming Chat ──

app.post('/api/chat/stream', async (req, res) => {
  const { chatId, userMessageContent, settings: reqSettings, useMCPTools, images } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const globalSettings = await getSettings();
    const settings = { ...globalSettings, ...reqSettings };
    const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
    const model = settings.model;

    if (!model) {
      sendEvent('error', { message: 'No model selected' });
      res.end();
      return;
    }

    // Load or create chat
    let chat = chatId ? await getChat(chatId) : null;
    if (!chat) {
      chat = {
        id: chatId || uuidv4(),
        name: 'New Chat',
        projectId: null,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    // Add user message
    const userMsg = { role: 'user', content: userMessageContent, timestamp: Date.now() };
    if (images && images.length > 0) userMsg.images = images;
    chat.messages.push(userMsg);

    // Auto-rename chat from first message
    if (chat.messages.filter(m => m.role === 'user').length === 1) {
      const words = userMessageContent.trim().split(/\s+/).slice(0, 5).join(' ');
      chat.name = words.length > 0 ? words : 'New Chat';
    }

    // Build context messages (limit by ctxLimit, include tool messages for continuity)
    const ctxLimit = settings.ctxLimit || 20;
    // Count only user+assistant messages toward the limit, but include their tool messages
    const allMsgs = chat.messages;
    let contextMsgs = [];
    let counted = 0;
    for (let i = allMsgs.length - 1; i >= 0 && counted < ctxLimit; i--) {
      contextMsgs.unshift(allMsgs[i]);
      if (allMsgs[i].role === 'user' || (allMsgs[i].role === 'assistant' && !allMsgs[i].tool_calls)) {
        counted++;
      }
    }

    // Build system prompt — always inject current datetime
    let systemPrompt = settings.systemPrompt || '';
    systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
      `Current date and time: ${new Date().toISOString()}`;

    // Optionally inject web search context
    if (settings.webSearch && userMessageContent) {
      try {
        const searchResult = await doWebSearch(userMessageContent, settings.searchEngine, settings);
        if (searchResult) {
          systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
            `Web search results for "${userMessageContent}":\n${searchResult}`;
        }
      } catch {}
    }

    // Optionally inject RAG context
    let ragChunksForSave = null; // Track RAG chunks to persist on assistant message
    if (settings.ragEnabled && settings.ragCollection) {
      try {
        sendEvent('rag_status', { status: 'searching', collection: settings.ragCollection });
        const colData = await getRagCollection(settings.ragCollection);
        // Use collection's embedding model to match what documents were embedded with
        const embModel = colData?.embeddingModel || settings.ragEmbeddingModel || 'nomic-embed-text';
        const queryEmbedding = await embedText(userMessageContent, embModel, ollamaUrl);
        if (colData) {
          const topK = settings.ragTopK || 3;
          const scored = [];
          for (const doc of (colData.documents || [])) {
            for (const chunk of (doc.chunks || [])) {
              const score = cosineSimilarity(queryEmbedding, chunk.embedding);
              scored.push({ text: chunk.text, score, docTitle: doc.title });
            }
          }
          scored.sort((a, b) => b.score - a.score);
          // Filter by minimum similarity threshold — low scores are noise
          const MIN_SCORE = 0.6;
          const top = scored.filter(c => c.score >= MIN_SCORE).slice(0, topK);
          if (top.length > 0) {
            const ragContext = top.map((c, i) => `[${i + 1}] (from "${c.docTitle}", score: ${c.score.toFixed(3)})\n${c.text}`).join('\n\n');
            systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
              `Relevant context from knowledge base:\n${ragContext}\n\nUse the above context to help answer the user's question. If the context is relevant, base your answer on it.`;
            ragChunksForSave = top.map(c => ({ text: c.text.slice(0, 200), score: c.score, docTitle: c.docTitle }));
            sendEvent('rag_status', {
              status: 'found', count: top.length, topScore: top[0].score,
              chunks: ragChunksForSave,
            });
          } else {
            sendEvent('rag_status', { status: 'no_results' });
          }
        }
      } catch (e) {
        console.error('RAG error:', e.message);
        sendEvent('rag_status', { status: 'error', message: e.message });
      }
    }

    // Build tools list — only web_search (when enabled) and MCP tools
    const tools = [];
    if (settings.webSearch) {
      const ws = BUILTIN_TOOLS.find(t => t.name === 'web_search');
      if (ws) tools.push({ type: 'function', function: { name: ws.name, description: ws.description, parameters: ws.parameters } });
    }
    if (useMCPTools !== false) {
      const mcpTools = getAllMCPTools();
      for (const t of mcpTools) {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: cleanToolSchema(t.inputSchema),
          },
        });
      }
    }

    // Messages for Ollama (without internal fields)
    function buildOllamaMessages(msgs) {
      const result = [];
      if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
      for (const m of msgs) {
        const msg = { role: m.role, content: m.content };
        if (m.images && m.images.length > 0) msg.images = m.images;
        // Preserve tool_calls on assistant messages so Ollama knows what was called
        if (m.role === 'assistant' && m.tool_calls) msg.tool_calls = m.tool_calls;
        // Preserve tool_call_id on tool result messages so Ollama can match them
        if (m.role === 'tool' && m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        result.push(msg);
      }
      return result;
    }

    // Tool calling loop
    let iterations = 0;
    const MAX_ITER = 10;
    let assistantContent = '';
    const pendingToolCalls = [];
    const savedToolMessages = []; // Track tool interactions for persistence
    let perfStats = null; // Ollama performance data from final response

    while (iterations < MAX_ITER) {
      iterations++;

      const ollamaBody = {
        model,
        messages: buildOllamaMessages(contextMsgs),
        stream: true,
        options: {
          temperature: settings.temperature,
          top_p: settings.top_p,
          top_k: settings.top_k,
          num_predict: settings.max_tokens,
          repeat_penalty: settings.repeat_penalty,
        },
      };
      if (tools.length > 0) {
        ollamaBody.tools = tools;
      }

      let ollamaResp;
      try {
        ollamaResp = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ollamaBody),
        });
      } catch (e) {
        sendEvent('error', { message: `Ollama connection error: ${e.message}` });
        res.end();
        return;
      }

      if (!ollamaResp.ok) {
        const errText = await ollamaResp.text();
        sendEvent('error', { message: `Ollama error ${ollamaResp.status}: ${errText}` });
        res.end();
        return;
      }

      // Stream response
      const reader = ollamaResp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentToolCalls = [];
      let isDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }

          if (obj.message) {
            const msg = obj.message;
            if (msg.content) {
              assistantContent += msg.content;
              sendEvent('delta', { text: msg.content });
            }
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                // Accumulate tool calls — Ollama may send them across multiple chunks
                const existing = currentToolCalls.find(
                  c => (c.function?.name || c.name) === (tc.function?.name || tc.name)
                );
                if (!existing) currentToolCalls.push(tc);
              }
            }
          }
          if (obj.done) {
            isDone = true;
            // Capture Ollama performance metrics
            if (obj.eval_count || obj.eval_duration) {
              perfStats = {
                eval_count: obj.eval_count || 0,
                eval_duration: obj.eval_duration || 0,
                prompt_eval_count: obj.prompt_eval_count || 0,
                prompt_eval_duration: obj.prompt_eval_duration || 0,
                total_duration: obj.total_duration || 0,
              };
            }
          }
        }
      }

      // Handle remaining buffer
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf);
          if (obj.message?.tool_calls) {
            for (const tc of obj.message.tool_calls) {
              const existing = currentToolCalls.find(
                c => (c.function?.name || c.name) === (tc.function?.name || tc.name)
              );
              if (!existing) currentToolCalls.push(tc);
            }
          }
          if (obj.done) {
            isDone = true;
            if (obj.eval_count || obj.eval_duration) {
              perfStats = {
                eval_count: obj.eval_count || 0,
                eval_duration: obj.eval_duration || 0,
                prompt_eval_count: obj.prompt_eval_count || 0,
                prompt_eval_duration: obj.prompt_eval_duration || 0,
                total_duration: obj.total_duration || 0,
              };
            }
          }
        } catch {}
      }

      // If no tool calls, we're done
      if (currentToolCalls.length === 0 || !isDone) {
        break;
      }

      // Save assistant message with tool_calls for persistence
      const toolCallData = currentToolCalls.map(tc => ({
        id: tc.id || uuidv4(),
        name: tc.function?.name || tc.name,
        args: tc.function?.arguments || tc.arguments || {},
      }));
      savedToolMessages.push({
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: toolCallData,
        timestamp: Date.now(),
      });

      // Add assistant message with tool calls to context
      contextMsgs.push({
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: currentToolCalls,
      });

      for (const tc of currentToolCalls) {
        const fnName = tc.function?.name || tc.name;
        const fnArgs = tc.function?.arguments || tc.arguments || {};
        const callId = tc.id || uuidv4();

        sendEvent('tool_call_start', { id: callId, name: fnName, args: fnArgs });

        let result = '';
        try {
          // Check built-in first, then MCP
          const builtinNames = BUILTIN_TOOLS.map(t => t.name);
          if (builtinNames.includes(fnName)) {
            result = await callBuiltinTool(fnName, fnArgs, settings);
          } else if (useMCPTools !== false) {
            result = await callMCPTool(fnName, fnArgs);
          } else {
            result = `Tool ${fnName} not available`;
          }
        } catch (e) {
          result = `Tool error: ${e.message}. You MUST retry the tool call with corrected arguments.`;
        }

        sendEvent('tool_call_result', { id: callId, name: fnName, result });

        // Save tool result for persistence
        savedToolMessages.push({
          role: 'tool',
          content: String(result),
          name: fnName,
          tool_call_id: callId,
          timestamp: Date.now(),
        });

        // Add tool result to context
        contextMsgs.push({
          role: 'tool',
          content: String(result),
          tool_call_id: callId,
        });
      }

      sendEvent('tool_calls_done', {});

      // Reset for next iteration
      assistantContent = '';
    }

    // Find project chatsDir for saving
    let projectChatsDir = null;
    if (chat.projectId) {
      const projects = await getProjects();
      const proj = projects.find(p => p.id === chat.projectId);
      if (proj?.chatsDir) projectChatsDir = proj.chatsDir;
    }

    // Save tool call history and final assistant message to chat
    for (const saved of savedToolMessages) {
      chat.messages.push(saved);
    }
    // Build performance summary (before saving so we can persist on message)
    let perfData = null;
    if (perfStats) {
      const tokPerSec = perfStats.eval_duration > 0 ? (perfStats.eval_count / (perfStats.eval_duration / 1e9)).toFixed(1) : null;
      perfData = {
        tokens: perfStats.eval_count,
        promptTokens: perfStats.prompt_eval_count,
        tokPerSec: tokPerSec ? parseFloat(tokPerSec) : null,
        totalMs: perfStats.total_duration ? Math.round(perfStats.total_duration / 1e6) : null,
      };
    }

    if (assistantContent) {
      const asstMsg = { role: 'assistant', content: assistantContent, timestamp: Date.now() };
      if (perfData) asstMsg._perf = perfData;
      if (ragChunksForSave) asstMsg._ragChunks = ragChunksForSave;
      chat.messages.push(asstMsg);
    }
    chat.updatedAt = Date.now();
    await saveChat(chat, projectChatsDir);

    const doneData = { chatId: chat.id, chatName: chat.name };
    if (perfData) doneData.perf = perfData;
    sendEvent('done', doneData);
    res.end();
  } catch (e) {
    console.error('Stream error:', e);
    try { sendEvent('error', { message: e.message }); } catch {}
    res.end();
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function startup() {
  await ensureDataDirs();

  // Auto-connect MCP servers
  const servers = await getMCPServers();
  for (const s of servers) {
    if (s.autoConnect) {
      try {
        console.log(`[MCP] Auto-connecting: ${s.name}`);
        await connectMCPServer(s);
        console.log(`[MCP] Connected: ${s.name}`);
      } catch (e) {
        console.error(`[MCP] Failed to connect ${s.name}:`, e.message);
      }
    }
  }

  app.listen(PORT, () => {
    console.log(`\n▓ OLLAMA TUI v2.0 listening on http://localhost:${PORT}\n`);
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[Shutdown] Disconnecting MCP servers...');
  for (const [id] of mcpConnections) {
    await disconnectMCPServer(id);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startup().catch(e => { console.error('Startup error:', e); process.exit(1); });
