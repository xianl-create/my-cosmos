/**
 * My Cosmos — Local Server
 * Run:  node server.js
 * Open: http://localhost:3000 (override port: MY_COSMOS_PORT or PORT)
 * Zero npm dependencies. Stores data as JSON under the project data/ folder by default.
 * Override with MY_COSMOS_DATA=/path/to/data (or legacy PROGRESS_TRACKER_DATA) for a different directory.
 * Optional: MY_COSMOS_EMBED_PRELOAD=1 (or PROGRESS_TRACKER_EMBED_PRELOAD=1) embeds the first *_data.json user into index.html on each save (off by default).
 * Agents local inference: POST /api/agents-local — GPT-2 via python3 scripts/agents_local_infer.py (MY_COSMOS_GPT2_MODEL, MY_COSMOS_PYTHON); Ollama via localhost:11434 (MY_COSMOS_OLLAMA_MODEL default gemma4:e4b, MY_COSMOS_OLLAMA_HOST, MY_COSMOS_OLLAMA_PORT).
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* Optional deps — required only for the in-app interactive Terminal column.
   Server still boots if they're missing (terminal column degrades to a clear error). */
let nodePty = null;
let WSServer = null;
try { nodePty = require('node-pty'); } catch (_) { /* terminal column will report missing dep */ }
try { WSServer = require('ws').WebSocketServer; } catch (_) { /* same */ }

const PORT = parseInt(process.env.MY_COSMOS_PORT || process.env.PORT, 10) || 3000;
/** Public hosted deployment (MY_COSMOS_PUBLIC=1): per-account auth is enforced, the
 *  local-only pages/APIs are disabled, and data/ is never served or embedded. The
 *  developer machine never sets this, so local behavior is completely unchanged. */
const PUBLIC_MODE = process.env.MY_COSMOS_PUBLIC === '1';
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'data');
const DATA_DIR = (process.env.MY_COSMOS_DATA || process.env.PROGRESS_TRACKER_DATA)
  ? path.resolve(process.env.MY_COSMOS_DATA || process.env.PROGRESS_TRACKER_DATA)
  : DEFAULT_DATA_DIR;
const SAVEPOINT_DIR = path.join(DATA_DIR, 'savepoints');
/** Shipped defaults only — not listed as a login user (see `data/template-user_data.json`). */
function isReservedTemplateUserDataFile(filename) {
  return /^template-user_data\.json$/i.test(filename || '');
}
/** Home-dir fallbacks (checked in order) when project data/ is still empty. */
const LEGACY_HOME_DATA_CANDIDATES = [
  path.join(os.homedir(), '.progress-tracker', 'data'),
  path.join(os.homedir(), '.my-cosmos', 'data'),
];

[DATA_DIR, SAVEPOINT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/** Write entire file atomically (crash-safe): temp in same dir, then rename/replace. */
function atomicWriteFileSync(destPath, content) {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    if (process.platform === 'win32' && fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch (e) { /* keep trying rename */ }
    }
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try {
      fs.copyFileSync(tmp, destPath);
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    } catch (e3) {
      try { fs.unlinkSync(tmp); } catch (e4) { /* ignore */ }
      throw e3;
    }
  }
}

function listUserJsonBasenames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => {
    if (!f.endsWith('.json') || f.includes('_sp_')) return false;
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
}

function firstLegacyHomeDataDirWithUserJson() {
  for (const dir of LEGACY_HOME_DATA_CANDIDATES) {
    if (fs.existsSync(dir) && listUserJsonBasenames(dir).length > 0) return dir;
  }
  return null;
}

// One-time migration: default project data/ empty → copy from ~/.progress-tracker/data or ~/.my-cosmos/data
if (!process.env.MY_COSMOS_DATA && !process.env.PROGRESS_TRACKER_DATA) {
  const here = listUserJsonBasenames(DATA_DIR);
  if (here.length === 0) {
    const LEGACY_DATA_DIR = firstLegacyHomeDataDirWithUserJson();
    if (LEGACY_DATA_DIR) {
      const there = listUserJsonBasenames(LEGACY_DATA_DIR);
      if (there.length > 0) {
        try {
          there.forEach(f => {
            fs.copyFileSync(path.join(LEGACY_DATA_DIR, f), path.join(DATA_DIR, f));
          });
          const legSp = path.join(LEGACY_DATA_DIR, 'savepoints');
          if (fs.existsSync(legSp)) {
            fs.readdirSync(legSp).forEach(f => {
              const src = path.join(legSp, f);
              try {
                if (fs.statSync(src).isFile()) {
                  fs.copyFileSync(src, path.join(SAVEPOINT_DIR, f));
                }
              } catch (e) { /* skip */ }
            });
          }
          console.log(`📦 Migrated ${there.length} user file(s) from ${LEGACY_DATA_DIR} → ${DATA_DIR}`);
        } catch (e) { console.warn('Legacy migration warning:', e.message); }
      }
    }
  }
}

const MIME = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon' };

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.end(JSON.stringify(data));
}
function readBody(req) { return new Promise((resolve, reject) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); req.on('error', reject); }); }

/** POST JSON to local HTTP (Ollama). */
function httpPostLocalJson(hostname, port, pathname, jsonBody) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(jsonBody), 'utf8');
    const req = http.request(
      {
        hostname,
        port,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      },
      (resp) => {
        let b = '';
        resp.on('data', (c) => { b += c; });
        resp.on('end', () => {
          try {
            resolve({ status: resp.statusCode, body: JSON.parse(b || '{}') });
          } catch (e) {
            reject(new Error((b || '').slice(0, 400)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/** GPT-2 via bundled Python (same stack as 5_story-geometry: transformers + openai-community/gpt2). */
function runLocalGpt2Infer(prompt) {
  const scriptPath = path.join(__dirname, 'agents_local_infer.py');
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({ ok: false, error: 'Missing scripts/agents_local_infer.py' });
  }
  const py = process.env.MY_COSMOS_PYTHON || 'python3';
  return new Promise((resolve) => {
    const proc = spawn(py, [scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '';
    let err = '';
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      resolve({ ok: false, error: 'GPT-2 timed out (120s). First run may download model weights.' });
    }, 120000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '{}';
      try {
        const j = JSON.parse(last);
        if (j.ok === false) return resolve(j);
        if (code !== 0 && code !== null) {
          return resolve({ ok: false, error: (j.error || err || out || `python exited ${code}`).slice(0, 1200) });
        }
        return resolve({ ok: true, text: j.text || '', meta: j.meta });
      } catch (e) {
        return resolve({ ok: false, error: (err || out || e.message).slice(0, 800) });
      }
    });
    proc.stdin.write(Buffer.from(prompt, 'utf8'));
    proc.stdin.end();
  });
}

function extractOllamaAssistantText(body) {
  if (!body || typeof body !== 'object') return '';
  const m = body.message;
  if (m && typeof m.content === 'string') return m.content;
  if (m && Array.isArray(m.content)) {
    return m.content.map((p) => (p && typeof p === 'object' ? (p.text || '') : '')).join('');
  }
  if (typeof body.response === 'string') return body.response;
  return '';
}

/** Ollama — try /api/generate (simplest), then /api/chat (matches causal-rating style for Gemma). */
async function runLocalOllamaGemmaInfer(prompt, maxPredict) {
  const host = process.env.MY_COSMOS_OLLAMA_HOST || '127.0.0.1';
  const port = parseInt(process.env.MY_COSMOS_OLLAMA_PORT || '11434', 10);
  const model = process.env.MY_COSMOS_OLLAMA_MODEL || 'gemma4:e4b';
  const opts = { temperature: 0.75, num_predict: maxPredict };

  const runGenerate = async () => {
    const { status, body } = await httpPostLocalJson(host, port, '/api/generate', {
      model,
      prompt,
      stream: false,
      options: opts,
    });
    if (body && body.error) return { ok: false, error: `Ollama generate: ${body.error}` };
    if (status !== 200) return { ok: false, error: `Ollama /api/generate HTTP ${status}` };
    const text = typeof body.response === 'string' ? body.response : extractOllamaAssistantText(body);
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'Ollama returned an empty response (generate).' };
    return { ok: true, text: t, meta: { model, endpoint: '/api/generate' } };
  };

  const runChat = async (withThink) => {
    const payload = {
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      options: opts,
    };
    if (withThink) payload.think = false;
    const { status, body } = await httpPostLocalJson(host, port, '/api/chat', payload);
    if (body && body.error) return { ok: false, error: `Ollama chat: ${body.error}` };
    if (status !== 200) return { ok: false, error: `Ollama /api/chat HTTP ${status}` };
    const text = extractOllamaAssistantText(body);
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'Ollama returned an empty response (chat).' };
    return { ok: true, text: t, meta: { model, endpoint: '/api/chat', think: withThink } };
  };

  try {
    const g = await runGenerate();
    if (g.ok) return g;
    const c0 = await runChat(false);
    if (c0.ok) return c0;
    const c1 = await runChat(true);
    if (c1.ok) return c1;
    return { ok: false, error: [g.error, c0.error, c1.error].filter(Boolean).join(' · ') };
  } catch (e) {
    return { ok: false, error: `Ollama at ${host}:${port}: ${e.message}` };
  }
}

async function handleAgentsLocal(body) {
  const model = body.model;
  const prompt = String(body.prompt || '');
  const maxTok = Math.min(Math.max(parseInt(body.maxTokens, 10) || 256, 16), 512);
  if (!prompt.trim()) return { ok: false, error: 'prompt required' };
  if (model === 'local-gpt2') return runLocalGpt2Infer(prompt);
  if (model === 'local-ollama-gemma') return runLocalOllamaGemmaInfer(prompt, maxTok);
  return { ok: false, error: 'unknown local model' };
}

/* ── Story Studio backend (additive; powers studio.html) ──────────────────
   Reuses the same Ollama/GPT-2 stack as the Agents page, but adds:
   • findStorytellerCore()  — locates the user-created "storyteller" agent and
     returns its goal.md / approach.md (the "core md" that drives the studio).
   • runOllamaModel()       — generic generate against any installed Ollama model
     (the Agents path is locked to one env model; the studio lets the UI pick).
   • listOllamaModels()     — proxies /api/tags so the UI can populate a picker.
   None of the existing functions above are modified. */

/** GET JSON from a local HTTP service (Ollama tags). */
function httpGetLocalJson(hostname, port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, method: 'GET' }, (resp) => {
      let b = '';
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(b || '{}') }); }
        catch (e) { reject(new Error((b || '').slice(0, 400))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Scan every user's agents dir for the "storyteller" agent and return its core md. */
function findStorytellerCore() {
  let userDirs = [];
  try {
    userDirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((de) => de.isDirectory())
      .map((de) => de.name);
  } catch (e) { return null; }
  for (const user of userDirs) {
    const root = path.join(DATA_DIR, user, 'agents');
    if (!fs.existsSync(root)) continue;
    let slugs = [];
    try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((de) => de.isDirectory()).map((de) => de.name); }
    catch (e) { continue; }
    for (const slug of slugs) {
      const dp = path.join(root, slug, 'detail.json');
      if (!fs.existsSync(dp)) continue;
      let det;
      try { det = JSON.parse(fs.readFileSync(dp, 'utf8')); } catch (e) { continue; }
      if (String(det.name || '').toLowerCase() !== 'storyteller') continue;
      const readMd = (file, fallback) => {
        const fp = path.join(root, slug, file);
        try { if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8'); } catch (e) { /* ignore */ }
        return fallback || '';
      };
      return {
        ok: true,
        name: det.name,
        slug,
        user,
        goalMd: readMd('goal.md', det.goalMd || ''),
        approachMd: readMd('approach.md', det.approachMd || ''),
      };
    }
  }
  return null;
}

/** Generic Ollama generate against an explicit model id (with /api/chat fallback). */
async function runOllamaModel(model, prompt, opts) {
  const host = process.env.MY_COSMOS_OLLAMA_HOST || '127.0.0.1';
  const port = parseInt(process.env.MY_COSMOS_OLLAMA_PORT || '11434', 10);
  const m = String(model || process.env.MY_COSMOS_OLLAMA_MODEL || 'gemma4:e4b');
  const options = {
    temperature: typeof (opts && opts.temperature) === 'number' ? opts.temperature : 0.85,
    num_predict: Math.min(Math.max(parseInt(opts && opts.maxTokens, 10) || 700, 32), 4096),
  };
  try {
    const g = await httpPostLocalJson(host, port, '/api/generate', { model: m, prompt, stream: false, options });
    if (!(g.body && g.body.error) && g.status === 200) {
      const t = String(typeof g.body.response === 'string' ? g.body.response : extractOllamaAssistantText(g.body)).trim();
      if (t) return { ok: true, text: t, meta: { model: m, endpoint: '/api/generate' } };
    }
    const c = await httpPostLocalJson(host, port, '/api/chat', { model: m, stream: false, messages: [{ role: 'user', content: prompt }], options });
    if (!(c.body && c.body.error) && c.status === 200) {
      const t = String(extractOllamaAssistantText(c.body)).trim();
      if (t) return { ok: true, text: t, meta: { model: m, endpoint: '/api/chat' } };
    }
    const why = (g.body && g.body.error) || (c.body && c.body.error) || `HTTP ${g.status}/${c.status}`;
    return { ok: false, error: `Ollama (${m}): ${why}` };
  } catch (e) {
    return { ok: false, error: `Ollama at ${host}:${port}: ${e.message}` };
  }
}

/** List installed Ollama models (name + parameter size) for the studio model picker. */
async function listOllamaModels() {
  const host = process.env.MY_COSMOS_OLLAMA_HOST || '127.0.0.1';
  const port = parseInt(process.env.MY_COSMOS_OLLAMA_PORT || '11434', 10);
  try {
    const { status, body } = await httpGetLocalJson(host, port, '/api/tags');
    if (status !== 200 || !body || !Array.isArray(body.models)) return { ok: false, error: `Ollama /api/tags HTTP ${status}`, models: [] };
    const models = body.models.map((m) => ({ name: m.name, size: (m.details && m.details.parameter_size) || '' }));
    return { ok: true, models, defaultModel: process.env.MY_COSMOS_OLLAMA_MODEL || 'gemma4:e4b' };
  } catch (e) {
    return { ok: false, error: `Ollama at ${host}:${port}: ${e.message}`, models: [] };
  }
}

/** Dispatch a single story-generation call. model: 'ollama:<id>' | 'local-gpt2' | 'local-ollama-gemma'. */
async function handleStoryGenerate(body) {
  const prompt = String(body.prompt || '');
  if (!prompt.trim()) return { ok: false, error: 'prompt required' };
  const model = String(body.model || 'local-ollama-gemma');
  const opts = { temperature: body.temperature, maxTokens: body.maxTokens };
  if (model === 'local-gpt2') return runLocalGpt2Infer(prompt);
  if (model.startsWith('ollama:')) return runOllamaModel(model.slice('ollama:'.length), prompt, opts);
  return runOllamaModel(undefined, prompt, opts); // default env model
}

/** Loopback-only check for sensitive endpoints (terminal). Trusts only direct localhost connections,
 *  not X-Forwarded-For headers (which a reverse proxy could spoof). */
function isLoopbackRequest(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Run a shell command for the in-app Terminal modal. Bash-like via the user's $SHELL (or /bin/sh on POSIX,
 *  cmd.exe on Windows). Hard caps: 30 s wall time, 1 MB combined output. Returns the same shape the client
 *  expects: { ok, stdout, stderr, exitCode, signal? } or { ok:false, error }. */
function runTerminalCommand(body) {
  return new Promise((resolve) => {
    const command = typeof body.command === 'string' ? body.command : '';
    if (!command.trim()) { resolve({ ok: false, error: 'command required' }); return; }
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    const cwd = REPO_ROOT;
    let stdout = '';
    let stderr = '';
    const MAX_BYTES = 1024 * 1024;
    let truncated = false;
    let child;
    try {
      child = spawn(shell, args, { cwd, env: process.env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message || 'spawn failed' });
      return;
    }
    const append = (which, chunk) => {
      const room = MAX_BYTES - (stdout.length + stderr.length);
      if (room <= 0) { truncated = true; try { child.kill('SIGTERM'); } catch (_) {} return; }
      const s = chunk.toString('utf8');
      if (s.length > room) {
        if (which === 'stdout') stdout += s.slice(0, room);
        else stderr += s.slice(0, room);
        truncated = true;
        try { child.kill('SIGTERM'); } catch (_) {}
      } else {
        if (which === 'stdout') stdout += s;
        else stderr += s;
      }
    };
    child.stdout.on('data', (c) => append('stdout', c));
    child.stderr.on('data', (c) => append('stderr', c));
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
      stderr += (stderr && !stderr.endsWith('\n') ? '\n' : '') + '[timeout: command exceeded 30 s and was terminated]\n';
    }, 30000);
    child.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ ok: false, error: e.message || 'shell error' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (truncated) {
        const note = '\n[output truncated at 1 MB]\n';
        if (stdout.length >= stderr.length) stdout += note;
        else stderr += note;
      }
      resolve({ ok: true, stdout, stderr, exitCode: code, signal: signal || null });
    });
  });
}

/** Forward a chat completion to Anthropic's Messages API. The browser can't reach api.anthropic.com
 *  directly (CORS) so we proxy from the local server instead. The API key never leaves this machine.
 *  Body shape from the client: { key, model, messages, maxTokens?, system?, version? }
 *  Returns either { ok:true, text, raw } or { ok:false, error }. */
function proxyAnthropicMessages(body) {
  return new Promise((resolve) => {
    const key = String((body && body.key) || '').trim();
    if (!key) { resolve({ ok: false, error: 'Anthropic API key required.' }); return; }
    const model = String((body && body.model) || 'claude-opus-4-7').trim() || 'claude-opus-4-7';
    const maxTokens = Math.max(16, Math.min(8192, parseInt((body && body.maxTokens) || 1024, 10) || 1024));
    const messages = Array.isArray(body && body.messages) ? body.messages : null;
    if (!messages || !messages.length) { resolve({ ok: false, error: 'messages[] required.' }); return; }
    const payload = { model, max_tokens: maxTokens, messages };
    if (body && body.system) payload.system = String(body.system);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const opts = {
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': String((body && body.version) || '2023-06-01'),
        'content-length': data.length,
      },
    };
    const req = https.request(opts, (resp) => {
      let buf = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { buf += c; });
      resp.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) { /* leave null */ }
        if (resp.statusCode && resp.statusCode >= 400) {
          const msg = (parsed && parsed.error && parsed.error.message) || ('HTTP ' + resp.statusCode + ': ' + buf.slice(0, 300));
          resolve({ ok: false, error: msg, status: resp.statusCode, raw: parsed || buf });
          return;
        }
        if (!parsed) { resolve({ ok: false, error: 'Anthropic returned non-JSON', raw: buf.slice(0, 300) }); return; }
        let text = '';
        if (Array.isArray(parsed.content)) {
          for (const block of parsed.content) {
            if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
          }
        }
        resolve({ ok: true, text, model: parsed.model || model, stopReason: parsed.stop_reason || null, raw: parsed });
      });
    });
    req.on('error', (e) => { resolve({ ok: false, error: 'Anthropic request failed: ' + e.message }); });
    req.setTimeout(60000, () => { try { req.destroy(new Error('timeout after 60s')); } catch (_) {} });
    req.write(data);
    req.end();
  });
}

/** Per-user agent archive: data/{base}/agents/manifest.json + data/{base}/agents/{slug}/detail.json */
function agentsDataRootForUser(username) {
  const base = storageBaseKey(sanitize(username));
  return path.join(DATA_DIR, base, 'agents');
}

function readAgentsArchiveForUser(username) {
  const empty = { version: 1, summary: [], graph: { nodes: [], edges: [] }, agents: {} };
  const root = agentsDataRootForUser(username);
  if (!fs.existsSync(root)) return empty;
  const mp = path.join(root, 'manifest.json');
  if (!fs.existsSync(mp)) return empty;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (e) {
    return empty;
  }
  const agents = {};
  const seen = new Set();
  (manifest.agentSlugs || []).forEach((slug) => {
    if (!/^[a-z0-9_-]{1,48}$/i.test(String(slug))) return;
    const fp = path.join(root, slug, 'detail.json');
    if (fs.existsSync(fp)) {
      try {
        agents[slug] = JSON.parse(fs.readFileSync(fp, 'utf8'));
        seen.add(slug);
      } catch (e) { /* skip */ }
    }
  });
  try {
    fs.readdirSync(root, { withFileTypes: true }).forEach((de) => {
      if (!de.isDirectory()) return;
      const slug = de.name;
      if (seen.has(slug)) return;
      if (!/^[a-z0-9_-]{1,48}$/i.test(slug)) return;
      const fp = path.join(root, slug, 'detail.json');
      if (fs.existsSync(fp)) {
        try { agents[slug] = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { /* skip */ }
      }
    });
  } catch (e) { /* ignore */ }
  return {
    version: manifest.version || 1,
    summary: Array.isArray(manifest.summary) ? manifest.summary : [],
    graph: manifest.graph && typeof manifest.graph === 'object' ? manifest.graph : { nodes: [], edges: [] },
    agents,
  };
}

function writeAgentsArchiveForUser(username, state) {
  const base = storageBaseKey(sanitize(username));
  const root = path.join(DATA_DIR, base, 'agents');
  fs.mkdirSync(root, { recursive: true });
  const agents = (state && state.agents && typeof state.agents === 'object') ? state.agents : {};
  const summary = Array.isArray(state.summary) ? state.summary : [];
  const graph = (state.graph && typeof state.graph === 'object') ? state.graph : { nodes: [], edges: [] };
  const version = state.version || 1;
  const agentSlugs = Object.keys(agents).filter((s) => /^[a-z0-9_-]{1,48}$/i.test(s));
  // Data-loss guard: never let an EMPTY agent archive overwrite a populated one.
  // A stale browser tab whose in-memory archive failed to load was flushing
  // {agents:{}} on unload (beforeunload/pagehide/visibilitychange all call
  // pageAgentsFlushArchiveSync unconditionally) and wiping all agent history.
  // If the incoming payload has no agents but the existing on-disk archive does,
  // snapshot the existing archive and KEEP it instead of clobbering. (Genuinely
  // deleting your last agent is rare; recover it from the backup dir if needed.)
  if (agentSlugs.length === 0) {
    let existingSlugs = [];
    try {
      const mp = path.join(root, 'manifest.json');
      if (fs.existsSync(mp)) {
        const cur = JSON.parse(fs.readFileSync(mp, 'utf8'));
        if (Array.isArray(cur.agentSlugs)) existingSlugs = cur.agentSlugs.slice();
      }
      if (existingSlugs.length === 0 && fs.existsSync(root)) {
        existingSlugs = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^[a-z0-9_-]{1,48}$/i.test(d.name)
            && fs.existsSync(path.join(root, d.name, 'detail.json')))
          .map((d) => d.name);
      }
    } catch (_) { /* ignore */ }
    if (existingSlugs.length > 0) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.cpSync(root, path.join(DATA_DIR, base, 'agents_autobackup_' + stamp), { recursive: true });
      } catch (_) { /* best-effort backup */ }
      console.warn(`⚠️  Refused empty agents overwrite for ${username} (would have wiped ${existingSlugs.length} agents); existing archive kept.`);
      return { ok: true, skipped: 'refused-empty-overwrite', preserved: existingSlugs.length };
    }
  }
  const manifest = { version, summary, graph, agentSlugs };
  atomicWriteFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ghQueue(`${base}/agents/manifest.json`);
  // Delete on-disk agent directories that are no longer in the archive. Without this
  // step, removing an agent in Crew chooser only updates the manifest — and the read
  // path's directory-scan fallback would resurrect the orphaned detail.json on next
  // load, which is what users saw as "deleted agent came back after refresh".
  const liveSet = new Set(agentSlugs);
  try {
    fs.readdirSync(root, { withFileTypes: true }).forEach((de) => {
      if (!de.isDirectory()) return;
      const slug = de.name;
      if (!/^[a-z0-9_-]{1,48}$/i.test(slug)) return;
      if (liveSet.has(slug)) return;
      try { fs.rmSync(path.join(root, slug), { recursive: true, force: true }); } catch (_) {}
      ghQueueDelete(`${base}/agents/${slug}/detail.json`);
    });
  } catch (_) { /* root not yet readable on first write — fine */ }
  agentSlugs.forEach((slug) => {
    const d = agents[slug];
    if (!d || typeof d !== 'object') return;
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    const detail = {
      slug,
      name: d.name || slug,
      runs: Array.isArray(d.runs) ? d.runs : [],
      collabLog: Array.isArray(d.collabLog) ? d.collabLog : [],
    };
    // Persist the compressed-history groups. These were previously dropped on
    // every save, so each flush silently lost the runs the client had folded
    // into runGroups (the cause of the jimmy/Lizzy history disappearing). The
    // client always sends them in its payload; keep them so all runs survive.
    if (Array.isArray(d.runGroups) && d.runGroups.length) {
      detail.runGroups = d.runGroups;
    }
    if (typeof d.preferredModel === 'string' && d.preferredModel.length < 80) {
      detail.preferredModel = d.preferredModel;
    }
    // Preserve UI/state flags so settings (Choose-crew → Settings) survive a
    // reload. Without these the server silently dropped the toggles on save
    // and the agent always came back visible/active on next login.
    if (typeof d.kind === 'string' && d.kind.length < 32) detail.kind = d.kind;
    if (typeof d.active === 'boolean') detail.active = d.active;
    if (typeof d.hiddenFromLoadList === 'boolean') detail.hiddenFromLoadList = d.hiddenFromLoadList;
    if (typeof d.justDoneNeedsAck === 'boolean') detail.justDoneNeedsAck = d.justDoneNeedsAck;
    if (typeof d.createdAt === 'number') detail.createdAt = d.createdAt;
    if (typeof d.lastActivity === 'number') detail.lastActivity = d.lastActivity;
    if (typeof d.transcript === 'string') {
      // Cap to match the client's 100 KB rolling-transcript intent so a runaway
      // session can't blow up the on-disk file.
      detail.transcript = d.transcript.slice(-102400);
    }
    // Last cwd the PTY reported (cwd poller) — used by the client to `cd` into
    // the prior directory on reload so Claude Code etc. resume the right project.
    if (typeof d.lastCwd === 'string' && d.lastCwd.length < 4096) detail.lastCwd = d.lastCwd;
    // Unfinished waitlist tabs (queued user messages that haven't drained yet) +
    // the paused/Hold flag. Restored paused-by-default on reload so the user
    // reviews them before any auto-dispatch fires. Cap each entry + total count
    // so a runaway queue can't blow up the on-disk file.
    if (Array.isArray(d.waitlist)) {
      detail.waitlist = d.waitlist
        .filter((t) => typeof t === 'string')
        .slice(0, 200)
        .map((t) => t.slice(0, 8192));
    }
    if (typeof d.waitlistPaused === 'boolean') detail.waitlistPaused = d.waitlistPaused;
    // Diverge lineage. divergedFrom is the parent slug; forkRunIndex is the
    // shared-prefix length at fork time so the tree branches cleanly. Both must
    // survive disk persistence or the lineage view degenerates after reload.
    if (typeof d.divergedFrom === 'string' && /^[a-z0-9_-]{1,48}$/i.test(d.divergedFrom)) {
      detail.divergedFrom = d.divergedFrom;
    }
    if (typeof d.forkRunIndex === 'number' && Number.isFinite(d.forkRunIndex)) {
      detail.forkRunIndex = d.forkRunIndex | 0;
    }
    // Agent ↔ task feature: an agent's goal + approach (its guiding .md files),
    // the tasks it works on, its read-only collaborators, and a user-created flag.
    // Persisted into detail.json so they round-trip on load (the read path returns
    // the whole detail.json as the agent record).
    if (typeof d.goalMd === 'string') detail.goalMd = d.goalMd.slice(0, 20000);
    if (typeof d.approachMd === 'string') detail.approachMd = d.approachMd.slice(0, 20000);
    if (Array.isArray(d.collaborators)) {
      detail.collaborators = d.collaborators
        .filter((s) => typeof s === 'string' && /^[a-z0-9_-]{1,48}$/i.test(s))
        .slice(0, 64);
    }
    if (Array.isArray(d.taskNodeIds)) {
      detail.taskNodeIds = d.taskNodeIds
        .filter((s) => typeof s === 'string' && s.length < 128)
        .slice(0, 2000);
    }
    if (typeof d.userCreated === 'boolean') detail.userCreated = d.userCreated;
    atomicWriteFileSync(path.join(dir, 'detail.json'), JSON.stringify(detail, null, 2));
    ghQueue(`${base}/agents/${slug}/detail.json`);
    // Also mirror the goal/approach as real .md files in the agent's own space so
    // they can be read directly (e.g. by a terminal agent). detail.json stays the
    // authoritative source; these are a human/agent-readable copy.
    try {
      if (typeof detail.goalMd === 'string' && detail.goalMd.trim()) {
        atomicWriteFileSync(path.join(dir, 'goal.md'), detail.goalMd);
      }
      if (typeof detail.approachMd === 'string' && detail.approachMd.trim()) {
        atomicWriteFileSync(path.join(dir, 'approach.md'), detail.approachMd);
      }
    } catch (_) { /* sidecar .md is best-effort */ }
    // A terminal agent is typically a Claude Code project rooted at its shell's
    // working directory. Mirror goal.md / approach.md directly into that project
    // dir (where `claude` was init'd) so Claude Code can read them. lastCwd comes
    // from the PTY cwd poller. Best-effort + guarded: only an existing absolute dir.
    if (!PUBLIC_MODE && d.kind === 'terminal' && typeof d.lastCwd === 'string' && d.lastCwd && path.isAbsolute(d.lastCwd)) {
      try {
        if (fs.existsSync(d.lastCwd) && fs.statSync(d.lastCwd).isDirectory()) {
          if (typeof detail.goalMd === 'string' && detail.goalMd.trim()) {
            atomicWriteFileSync(path.join(d.lastCwd, 'goal.md'), detail.goalMd);
          }
          if (typeof detail.approachMd === 'string' && detail.approachMd.trim()) {
            atomicWriteFileSync(path.join(d.lastCwd, 'approach.md'), detail.approachMd);
          }
        }
      } catch (_) { /* project-dir mirror is best-effort */ }
    }
  });
  return { ok: true };
}

/** HTTPS GET → JSON (for geocoding / Ticketmaster from the local server). */
function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'MyCosmos/1.0 (local; +https://github.com)' }, headers || {}),
    };
    https.get(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
function sanitize(name) { return name.replace(/[^a-zA-Z0-9_\-]/g, '').toLowerCase().slice(0, 50); }

/** Logical storage key: xianl and xianl_data both map to xianl → one canonical file xianl_data.json */
function storageBaseKey(username) {
  const u = sanitize(username);
  return u.replace(/_data$/, '') || u;
}

/** Basename without .json → base key for grouping xianl.json with xianl_data.json */
function storageBaseFromBasename(basename) {
  return basename.endsWith('_data') ? basename.replace(/_data$/, '') : basename;
}

function nodeCountFromData(data) {
  const n = data && data.nodes;
  if (Array.isArray(n)) return n.length;
  if (n && typeof n === 'object') return Object.keys(n).length;
  return 0;
}

function edgeCountFromData(data) {
  const e = data && data.edges;
  if (Array.isArray(e)) return e.length;
  if (e && typeof e === 'object') return Object.keys(e).length;
  return 0;
}

function graphHasPayload(data) {
  return !!data && typeof data === 'object' && (nodeCountFromData(data) > 0 || edgeCountFromData(data) > 0);
}

/** When *_data.json is missing or was saved as an empty shell, use the newest savepoint that still has a graph. */
function tryRecoverUserGraphFromSavepoints(usernameSan) {
  const prefs = savepointPrefixes(usernameSan);
  const candidates = [];
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || !f.includes('_sp_')) continue;
      if (!prefs.some((p) => f.startsWith(p + '_sp_'))) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        candidates.push({ fp, m: st.mtimeMs });
      } catch (e) { /* skip */ }
    }
  };
  collect(SAVEPOINT_DIR);
  collect(DATA_DIR);
  candidates.sort((a, b) => b.m - a.m);
  for (const { fp } of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (graphHasPayload(data)) return { data, fromPath: fp };
    } catch (e) { /* skip corrupt */ }
  }
  return null;
}

/** Prefixes used for savepoint filenames (xianl vs xianl_data, either direction) */
function savepointPrefixes(username) {
  const prefs = new Set([username]);
  if (!username.endsWith('_data')) prefs.add(username + '_data');
  else {
    const base = username.replace(/_data$/, '');
    if (base) prefs.add(base);
  }
  return [...prefs];
}

function listSavepointFilesForUser(username) {
  if (!fs.existsSync(SAVEPOINT_DIR)) return [];
  const prefs = savepointPrefixes(username);
  return fs.readdirSync(SAVEPOINT_DIR).filter(f => {
    if (!f.endsWith('.json') || !f.includes('_sp_')) return false;
    return prefs.some(p => f.startsWith(p + '_sp_'));
  });
}

const MAX_SAVEPOINTS = 5;
function pruneSavepoints(username) {
  try {
    const files = listSavepointFilesForUser(username);
    if (files.length <= MAX_SAVEPOINTS) return;
    files.sort((a, b) =>
      fs.statSync(path.join(SAVEPOINT_DIR, b)).mtimeMs - fs.statSync(path.join(SAVEPOINT_DIR, a)).mtimeMs
    );
    files.slice(MAX_SAVEPOINTS).forEach(f => {
      try { fs.unlinkSync(path.join(SAVEPOINT_DIR, f)); } catch (e) {}
    });
  } catch (e) {}
}

function pruneDataDirSavepoints(username) {
  try {
    const prefs = savepointPrefixes(username);
    const spFiles = fs.readdirSync(DATA_DIR).filter(f => {
      if (!f.endsWith('.json') || !f.includes('_sp_')) return false;
      return prefs.some(p => f.startsWith(p + '_sp_'));
    });
    if (spFiles.length <= MAX_SAVEPOINTS) return;
    spFiles.sort((a, b) =>
      fs.statSync(path.join(DATA_DIR, b)).mtimeMs - fs.statSync(path.join(DATA_DIR, a)).mtimeMs
    );
    spFiles.slice(MAX_SAVEPOINTS).forEach(f => {
      try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) {}
    });
  } catch (e) {}
}

function updatePreload(username, data) {
  if (PUBLIC_MODE) return; // never embed user data into a served file on the public deployment
  try {
    const u = username || (() => {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_data.json') && !f.includes('_sp_'));
      if (files.length === 0) return null;
      const f = files[0];
      return path.basename(f, '.json').replace(/_data$/, '');
    })();
    const d = data || (() => {
      const fp = path.join(DATA_DIR, `${u}_data.json`);
      return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : null;
    })();
    if (!u || !d) return;
    const bootJs = 'window.__PRELOAD_USER_DATA__=' + JSON.stringify({ username: u, data: d }) + ';\n';
    atomicWriteFileSync(path.join(DATA_DIR, 'file_boot.js'), bootJs);
  } catch (e) {}
}

/** Keeps data/file_boot.js + users_index.json aligned with *_data.json on disk (same as node scripts/prepare.js). Needed so double-click index.html (file://) loads — Chrome cannot fetch local JSON. */
function syncPrepareArtifactsFromDisk() {
  if (PUBLIC_MODE) return; // users_index.json / file_boot.js are file:// conveniences; they leak data if served
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f =>
      f.endsWith('_data.json') && !f.includes('_sp_') && !isReservedTemplateUserDataFile(f)
    );
    atomicWriteFileSync(path.join(DATA_DIR, 'users_index.json'), JSON.stringify({ files }, null, 2));
    if (files.length === 0) {
      atomicWriteFileSync(
        path.join(DATA_DIR, 'file_boot.js'),
        '/* Run: node scripts/prepare.js after adding data/*_data.json — needed for file:// in Chrome. */\n'
      );
      return;
    }
    updatePreload();
  } catch (e) {
    console.warn('syncPrepareArtifactsFromDisk:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ACCOUNTS & SESSIONS — passwords live in data/auth.json (scrypt hash + salt),
   sessions are in-memory tokens (a server restart signs everyone out; users
   simply log back in). Auth is only ENFORCED when MY_COSMOS_PUBLIC=1; the
   endpoints exist in local mode too but nothing requires them.
   ═══════════════════════════════════════════════════════════════════════════ */
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_PASSWORD_LEN = 8;
let _authDb = null;

function loadAuthDb() {
  if (_authDb) return _authDb;
  try { _authDb = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (_) { _authDb = null; }
  if (!_authDb || typeof _authDb !== 'object' || !_authDb.users || typeof _authDb.users !== 'object') {
    _authDb = { users: {} };
  }
  return _authDb;
}
function saveAuthDb() {
  atomicWriteFileSync(AUTH_FILE, JSON.stringify(loadAuthDb(), null, 2));
  ghQueue('auth.json');
}
function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

const _sessions = new Map(); // token -> { user, exp }
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  _sessions.set(token, { user, exp: Date.now() + SESSION_TTL_MS });
  return token;
}
/** Token comes as an X-Auth-Token header, or ?authtoken= for sendBeacon (which can't set headers). */
function sessionUser(req, url) {
  let token = String(req.headers['x-auth-token'] || '');
  if (!token && url) token = String(url.searchParams.get('authtoken') || '');
  if (!token) return '';
  const s = _sessions.get(token);
  if (!s) return '';
  if (Date.now() > s.exp) { _sessions.delete(token); return ''; }
  return s.user;
}

/* Basic per-IP limiter for the auth endpoints (public mode only). */
const _authAttempts = new Map(); // ip -> { n, resetAt }
function authRateLimited(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  if (_authAttempts.size > 10000) _authAttempts.clear(); // memory backstop
  let rec = _authAttempts.get(ip);
  if (!rec || now > rec.resetAt) { rec = { n: 0, resetAt: now + 10 * 60 * 1000 }; _authAttempts.set(ip, rec); }
  rec.n++;
  return rec.n > 30;
}

function userDataFileExists(base) {
  return fs.existsSync(path.join(DATA_DIR, `${base}_data.json`))
    || fs.existsSync(path.join(DATA_DIR, `${base}.json`));
}
function handleAuthRegister(body) {
  const base = storageBaseKey(sanitize(String((body && body.username) || '')));
  const password = String((body && body.password) || '');
  if (!base || base.length < 2) return { ok: false, error: 'Username needs at least 2 characters (letters, numbers, - or _).' };
  if (base === 'template-user') return { ok: false, error: 'That name is reserved.' };
  if (password.length < MIN_PASSWORD_LEN) return { ok: false, error: `Password needs at least ${MIN_PASSWORD_LEN} characters.` };
  const db = loadAuthDb();
  if (db.users[base] || userDataFileExists(base)) return { ok: false, error: 'That username is already taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[base] = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  saveAuthDb();
  console.log(`👤 Registered account: ${base}`);
  return { ok: true, username: base, token: createSession(base) };
}
function handleAuthLogin(body) {
  const base = storageBaseKey(sanitize(String((body && body.username) || '')));
  const password = String((body && body.password) || '');
  const rec = loadAuthDb().users[base];
  const fail = { ok: false, error: 'Wrong username or password.' };
  if (!base || !rec) return fail;
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(rec.hash, 'hex'), Buffer.from(hashPassword(password, rec.salt), 'hex'));
  } catch (_) { match = false; }
  if (!match) return fail;
  return { ok: true, username: base, token: createSession(base) };
}
function removeAuthUser(base) {
  const db = loadAuthDb();
  if (db.users[base]) { delete db.users[base]; saveAuthDb(); }
  for (const [t, s] of _sessions) { if (s.user === base) _sessions.delete(t); }
}

/** Public-mode gate. Returns true if it already answered the request (caller must return).
 *  Blocks: static data/ (and dotfiles), user listing, local-LLM + story + Ticketmaster APIs,
 *  and requires a session token matching the :user of every per-user data route. */
function publicModeGate(req, res, url, p) {
  if (!PUBLIC_MODE) return false;
  if (p === '/data/file_boot.js') { // index.html references it; serve a stub instead of user data
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('/* public deployment — no preload */\n');
    return true;
  }
  if ((p.startsWith('/data/') && p !== '/data/template-user_data.json') || p.includes('/.')) {
    // template-user_data.json is the shipped new-account UI shell — no user data in it
    res.writeHead(403); res.end('Forbidden');
    return true;
  }
  if ((p === '/api/users' || p === '/api/agents-local' || p.startsWith('/api/story/') || p === '/api/interstellar-events')
    && !isLoopbackRequest(req)) {
    sendJSON(res, 403, { ok: false, error: 'Not available on the public deployment.' });
    return true;
  }
  const owner = p.match(/^\/api\/(?:data|savepoint|savepoints|savepoint-file|agents-data)\/([^/]+)/);
  if (owner) {
    let uname = owner[1];
    try { uname = decodeURIComponent(uname); } catch (_) { /* keep raw */ }
    const base = storageBaseKey(sanitize(uname));
    const su = sessionUser(req, url);
    if (!su || su !== base) {
      sendJSON(res, 401, { error: 'Sign in required.' });
      return true;
    }
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GITHUB PRIVATE-REPO DATA SYNC — the durable store for hosted deployments
   whose local disk is ephemeral (e.g. Render free tier).
   • MY_COSMOS_GH_REPO="owner/repo" + MY_COSMOS_GH_TOKEN enable it; unset = off.
   • On boot: hydrate missing local files from the repo (repo paths mirror DATA_DIR).
   • On save: per-file debounce (15 s), then serialized Contents-API commits.
   • Savepoints are NOT synced — every push is a commit, so git history itself
     is the version trail.
   ═══════════════════════════════════════════════════════════════════════════ */
const GH_REPO = process.env.MY_COSMOS_GH_REPO || '';
const GH_TOKEN = process.env.MY_COSMOS_GH_TOKEN || '';
const GH_BRANCH = process.env.MY_COSMOS_GH_BRANCH || 'main';
const GH_ENABLED = !!(GH_REPO && GH_TOKEN);
const GH_PUSH_DEBOUNCE_MS = 15000;

function ghApi(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const headers = {
      'User-Agent': 'MyCosmos-sync',
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = https.request({ method, hostname: 'api.github.com', path: apiPath, headers }, (resp) => {
      let b = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b || 'null'); } catch (_) { /* non-JSON */ }
        resolve({ status: resp.statusCode || 0, body: parsed });
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => { try { r.destroy(new Error('GitHub API timeout')); } catch (_) {} });
    if (data) r.write(data);
    r.end();
  });
}
function ghContentsPath(relPath) {
  return `/repos/${GH_REPO}/contents/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

const _ghShaCache = new Map(); // relPath -> blob sha on the remote branch
const _ghTimers = new Map();   // relPath -> debounce timer
let _ghChain = Promise.resolve(); // serialize pushes so same-file commits never race

async function ghFetchSha(relPath) {
  const r = await ghApi('GET', `${ghContentsPath(relPath)}?ref=${encodeURIComponent(GH_BRANCH)}`);
  return (r.status === 200 && r.body && r.body.sha) ? r.body.sha : null;
}
async function ghPushFile(relPath) {
  const abs = path.join(DATA_DIR, relPath);
  if (!abs.startsWith(DATA_DIR)) return false;
  if (!fs.existsSync(abs)) return ghDeleteFile(relPath);
  const content = fs.readFileSync(abs).toString('base64');
  const put = (sha) => ghApi('PUT', ghContentsPath(relPath),
    Object.assign({ message: `sync ${relPath}`, content, branch: GH_BRANCH }, sha ? { sha } : {}));
  let sha = _ghShaCache.has(relPath) ? _ghShaCache.get(relPath) : await ghFetchSha(relPath);
  let r = await put(sha);
  if (r.status === 409 || r.status === 422) { // stale/missing sha — refetch once and retry
    sha = await ghFetchSha(relPath);
    r = await put(sha);
  }
  if (r.status === 200 || r.status === 201) {
    _ghShaCache.set(relPath, r.body && r.body.content && r.body.content.sha);
    return true;
  }
  console.warn(`⚠️  GitHub sync failed for ${relPath}: HTTP ${r.status} ${(r.body && r.body.message) || ''}`);
  return false;
}
async function ghDeleteFile(relPath) {
  const sha = _ghShaCache.get(relPath) || await ghFetchSha(relPath);
  if (!sha) return true; // nothing on the remote
  const r = await ghApi('DELETE', ghContentsPath(relPath), { message: `delete ${relPath}`, sha, branch: GH_BRANCH });
  if (r.status === 200) { _ghShaCache.delete(relPath); return true; }
  console.warn(`⚠️  GitHub delete failed for ${relPath}: HTTP ${r.status}`);
  return false;
}
/** Debounced push of one DATA_DIR-relative file. No-op unless GH sync is configured. */
function ghQueue(relPath) {
  if (!GH_ENABLED || !relPath || relPath.includes('..')) return;
  const t = _ghTimers.get(relPath);
  if (t) clearTimeout(t);
  _ghTimers.set(relPath, setTimeout(() => {
    _ghTimers.delete(relPath);
    _ghChain = _ghChain.catch(() => {}).then(() => ghPushFile(relPath).catch((e) => console.warn('gh sync:', e.message)));
  }, GH_PUSH_DEBOUNCE_MS));
}
function ghQueueDelete(relPath) {
  if (!GH_ENABLED || !relPath || relPath.includes('..')) return;
  const t = _ghTimers.get(relPath);
  if (t) { clearTimeout(t); _ghTimers.delete(relPath); }
  _ghChain = _ghChain.catch(() => {}).then(() => ghDeleteFile(relPath).catch((e) => console.warn('gh sync:', e.message)));
}
/** SIGTERM: push everything still debouncing before the process dies. */
function ghFlushAllNow() {
  const pending = [..._ghTimers.keys()];
  for (const t of _ghTimers.values()) clearTimeout(t);
  _ghTimers.clear();
  for (const rel of pending) {
    _ghChain = _ghChain.catch(() => {}).then(() => ghPushFile(rel).catch(() => {}));
  }
  return _ghChain;
}
/** Boot hydrate: copy every repo file missing locally into DATA_DIR (local files win). */
async function ghHydrateDataDir() {
  if (!GH_ENABLED) return;
  try {
    const tree = await ghApi('GET', `/repos/${GH_REPO}/git/trees/${encodeURIComponent(GH_BRANCH)}?recursive=1`);
    if (tree.status !== 200 || !tree.body || !Array.isArray(tree.body.tree)) {
      if (tree.status === 404 || tree.status === 409) { console.log(`📭 GitHub data repo ${GH_REPO} is empty — starting fresh.`); return; }
      console.warn(`⚠️  GitHub hydrate: HTTP ${tree.status} ${(tree.body && tree.body.message) || ''}`);
      return;
    }
    let restored = 0;
    for (const ent of tree.body.tree) {
      if (!ent || ent.type !== 'blob' || typeof ent.path !== 'string') continue;
      const rel = ent.path;
      if (rel.includes('..')) continue;
      const abs = path.join(DATA_DIR, rel);
      if (!abs.startsWith(DATA_DIR)) continue;
      _ghShaCache.set(rel, ent.sha);
      if (fs.existsSync(abs)) continue;
      const blob = await ghApi('GET', `/repos/${GH_REPO}/git/blobs/${ent.sha}`);
      if (blob.status !== 200 || !blob.body || typeof blob.body.content !== 'string') continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(blob.body.content, 'base64'));
      restored++;
    }
    if (restored > 0) console.log(`📥 Hydrated ${restored} file(s) from GitHub ${GH_REPO}@${GH_BRANCH}`);
  } catch (e) {
    console.warn('⚠️  GitHub hydrate failed:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/api/health' && req.method === 'GET') {
    sendJSON(res, 200, PUBLIC_MODE
      ? { ok: true, port: PORT, publicMode: true }
      : { ok: true, port: PORT, dataDir: DATA_DIR, agentsLocalApi: true, publicMode: false });
    return;
  }

  // ── Accounts (register / login / logout / whoami) ──
  if (p.startsWith('/api/auth/')) {
    if (PUBLIC_MODE && authRateLimited(req)) {
      sendJSON(res, 429, { ok: false, error: 'Too many attempts — try again in a few minutes.' });
      return;
    }
    try {
      if (p === '/api/auth/register' && req.method === 'POST') { sendJSON(res, 200, handleAuthRegister(await readBody(req))); return; }
      if (p === '/api/auth/login' && req.method === 'POST') { sendJSON(res, 200, handleAuthLogin(await readBody(req))); return; }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        _sessions.delete(String(req.headers['x-auth-token'] || ''));
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/auth/whoami' && req.method === 'GET') {
        const su = sessionUser(req, url);
        sendJSON(res, 200, su ? { ok: true, username: su } : { ok: false });
        return;
      }
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'Bad request' });
      return;
    }
    sendJSON(res, 404, { ok: false, error: 'Unknown auth endpoint' });
    return;
  }

  // ── Public deployment lockdown (no-op in local mode) ──
  if (publicModeGate(req, res, url, p)) return;

  if (p === '/api/agents-local' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await handleAgentsLocal(body);
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: e.message || 'agents-local failed' });
    }
    return;
  }

  // ── Story Studio (studio.html) ──
  if (p === '/api/story/core' && req.method === 'GET') {
    const core = findStorytellerCore();
    sendJSON(res, 200, core || { ok: false, error: 'No "storyteller" agent found in data/.' });
    return;
  }

  if (p === '/api/story/models' && req.method === 'GET') {
    sendJSON(res, 200, await listOllamaModels());
    return;
  }

  if (p === '/api/story/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      sendJSON(res, 200, await handleStoryGenerate(body));
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: e.message || 'story generate failed' });
    }
    return;
  }

  if (p === '/api/terminal' && req.method === 'POST') {
    if (!isLoopbackRequest(req)) {
      sendJSON(res, 403, { ok: false, error: 'Terminal API is only reachable from loopback (127.0.0.1 / ::1).' });
      return;
    }
    try {
      const body = await readBody(req);
      const result = await runTerminalCommand(body);
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: e.message || 'terminal failed' });
    }
    return;
  }

  if (p === '/api/proxy-anthropic' && req.method === 'POST') {
    if (!isLoopbackRequest(req)) {
      sendJSON(res, 403, { ok: false, error: 'Anthropic proxy is loopback-only.' });
      return;
    }
    try {
      const body = await readBody(req);
      const result = await proxyAnthropicMessages(body);
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: e.message || 'anthropic proxy failed' });
    }
    return;
  }

  if (p === '/api/users' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.includes('_sp_') && f !== 'users_index.json');
      const groups = new Map();
      for (const f of files) {
        if (isReservedTemplateUserDataFile(f)) continue;
        const base = storageBaseFromBasename(path.basename(f, '.json'));
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(f);
      }
      const users = [];
      for (const [, flist] of groups) {
        flist.sort((a, b) => {
          const da = a.endsWith('_data.json');
          const db = b.endsWith('_data.json');
          if (da !== db) return da ? -1 : 1;
          return fs.statSync(path.join(DATA_DIR, b)).mtimeMs - fs.statSync(path.join(DATA_DIR, a)).mtimeMs;
        });
        const f = flist[0];
        const username = path.basename(f, '.json');
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
          const nodeCount = nodeCountFromData(data);
          users.push({ username, displayName: data.displayName || username, nodeCount, lastModified: fs.statSync(path.join(DATA_DIR, f)).mtime });
        } catch { users.push({ username, displayName: username, nodeCount: 0, lastModified: fs.statSync(path.join(DATA_DIR, f)).mtime }); }
      }
      sendJSON(res, 200, { users });
    } catch (e) { sendJSON(res, 500, { error: 'Failed to list users' }); }
    return;
  }

  if (p.startsWith('/api/data/') && req.method === 'GET') {
    let rest = p.replace(/^\/api\/data\//, '');
    try {
      rest = decodeURIComponent(rest);
    } catch (e) { /* keep raw */ }
    const username = sanitize(rest.split('/')[0]);
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    const base = storageBaseKey(username);
    let fp = path.join(DATA_DIR, `${base}_data.json`);
    if (!fs.existsSync(fp)) fp = path.join(DATA_DIR, `${username}.json`);
    if (!fs.existsSync(fp)) fp = path.join(DATA_DIR, `${username}_data.json`);

    let data = null;
    if (fs.existsSync(fp)) {
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      } catch (e) {
        return sendJSON(res, 500, { error: 'Read failed' });
      }
    }

    if (!graphHasPayload(data)) {
      const rec = tryRecoverUserGraphFromSavepoints(username);
      if (rec) {
        const canonFp = path.join(DATA_DIR, `${base}_data.json`);
        try {
          atomicWriteFileSync(canonFp, JSON.stringify(rec.data, null, 2));
          console.warn(
            `[my-cosmos] Recovered "${base}" from ${path.relative(REPO_ROOT, rec.fromPath)} (main user JSON had no graph).`
          );
          syncPrepareArtifactsFromDisk();
          data = rec.data;
        } catch (e) {
          console.warn('[my-cosmos] Recovery write failed:', e.message);
          data = rec.data;
        }
      }
    }

    if (!data || !graphHasPayload(data)) return sendJSON(res, 404, { error: 'Not found' });
    try {
      sendJSON(res, 200, data);
    } catch (e) {
      sendJSON(res, 500, { error: 'Send failed' });
    }
    return;
  }

  if (p.startsWith('/api/data/') && req.method === 'POST') {
    const username = sanitize(p.replace(/^\/api\/data\//, '').split('/')[0]);
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    try {
      const data = await readBody(req);
      if(!data.lastSaved)data.lastSaved = new Date().toISOString();
      const jsonStr = JSON.stringify(data, null, 2);
      const base = storageBaseKey(username);
      const canonicalFp = path.join(DATA_DIR, `${base}_data.json`);
      atomicWriteFileSync(canonicalFp, jsonStr);
      const legacyFlat = path.join(DATA_DIR, `${base}.json`);
      try { if (fs.existsSync(legacyFlat) && legacyFlat !== canonicalFp) fs.unlinkSync(legacyFlat); } catch (e) { /* keep canonical */ }
      updatePreload(base, data);
      ghQueue(`${base}_data.json`);
      console.log(`💾 Saved ${username} → ${path.basename(canonicalFp)}`);
      sendJSON(res, 200, { ok: true });
    } catch (e) { console.error('Save error:', e); sendJSON(res, 500, { error: 'Save failed' }); }
    return;
  }

  if (p.startsWith('/api/data/') && req.method === 'DELETE') {
    const username = sanitize(p.replace('/api/data/', ''));
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    const base = storageBaseKey(username);
    const toRemove = new Set([
      path.join(DATA_DIR, `${base}_data.json`),
      path.join(DATA_DIR, `${base}.json`),
      path.join(DATA_DIR, `${username}.json`),
      path.join(DATA_DIR, `${username}_data.json`),
    ]);
    // Also match real on-disk files whose name normalizes to the same base,
    // covering legacy/recovery filenames that contain dots or uppercase chars
    // (e.g. xianl_data.OVERWRITTEN-WITH-HERON.20260502-025143.json) that the
    // four explicit paths above can't reconstruct.
    try {
      fs.readdirSync(DATA_DIR).forEach(f => {
        if (!f.endsWith('.json')) return;
        if (f.includes('_sp_')) return;
        if (f === 'users_index.json') return;
        if (isReservedTemplateUserDataFile(f)) return;
        const fileBase = storageBaseKey(storageBaseFromBasename(path.basename(f, '.json')));
        if (fileBase === base) toRemove.add(path.join(DATA_DIR, f));
      });
    } catch (e) {}
    toRemove.forEach(fp => {
      try {
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          ghQueueDelete(path.relative(DATA_DIR, fp));
        }
      } catch (e) {}
    });
    try {
      listSavepointFilesForUser(username).forEach(f => fs.unlinkSync(path.join(SAVEPOINT_DIR, f)));
    } catch (e) {}
    if (PUBLIC_MODE) removeAuthUser(base); // account deletion also revokes the login
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (p.startsWith('/api/savepoint/') && req.method === 'POST') {
    const username = sanitize(p.replace('/api/savepoint/', ''));
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    try {
      const data = await readBody(req);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${username}_sp_${ts}.json`;
      atomicWriteFileSync(path.join(SAVEPOINT_DIR, filename), JSON.stringify(data));
      pruneSavepoints(username);
      pruneDataDirSavepoints(username);
      console.log(`💾 Savepoint: ${filename}`);
      sendJSON(res, 200, { ok: true, filename });
    } catch (e) { sendJSON(res, 500, { error: 'Savepoint failed' }); }
    return;
  }

  if (p.startsWith('/api/savepoints/') && req.method === 'GET') {
    const rest = p.replace(/^\/api\/savepoints\//, '');
    if (rest.includes('/')) return sendJSON(res, 400, { error: 'Invalid username' });
    const username = sanitize(rest);
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    try {
      const files = listSavepointFilesForUser(username).sort((a, b) =>
        fs.statSync(path.join(SAVEPOINT_DIR, b)).mtimeMs - fs.statSync(path.join(SAVEPOINT_DIR, a)).mtimeMs
      );
      const savepoints = files.map(f => ({
        filename: f,
        timestamp: f.replace(/.*?_sp_/, '').replace('.json', ''),
        size: fs.statSync(path.join(SAVEPOINT_DIR, f)).size,
      }));
      sendJSON(res, 200, { savepoints });
    } catch (e) { sendJSON(res, 500, { error: 'Failed to list savepoints' }); }
    return;
  }

  if (p === '/api/interstellar-events' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const city = (body.city || '').trim();
      let lat = body.lat != null ? Number(body.lat) : NaN;
      let lng = body.lng != null ? Number(body.lng) : NaN;
      const tmKey = (body.tmApiKey || process.env.TICKETMASTER_API_KEY || '').trim();
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 31);
      const isoStart = `${now.toISOString().split('.')[0]}Z`;
      const isoEnd = `${end.toISOString().split('.')[0]}Z`;

      if ((Number.isNaN(lat) || Number.isNaN(lng)) && city) {
        try {
          const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
          const nom = await httpsGetJson(nomUrl, { Accept: 'application/json' });
          if (Array.isArray(nom) && nom[0]) {
            lat = parseFloat(nom[0].lat, 10);
            lng = parseFloat(nom[0].lon, 10);
          }
        } catch (e) {
          console.warn('Interstellar geocode:', e.message);
        }
      }

      const demo = () => {
        const loc = city || 'your area';
        const events = [];
        const samples = [
          { title: 'Neighborhood nature walk', desc: 'Guided stroll through local parks — demo card when no live listings match.', fee: 'Free' },
          { title: 'Community makers open hours', desc: 'Shared workspace open house — demo.', fee: 'Free' },
          { title: 'Outdoor yoga (donation-based)', desc: 'All levels welcome — demo.', fee: 'Donation' },
          { title: 'Library story time & crafts', desc: 'Youth program — demo.', fee: 'Free' },
          { title: 'Farmers market live music', desc: 'Weekend market stage — demo.', fee: 'Free to attend' },
        ];
        for (let i = 0; i < samples.length; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() + 3 + i * 5);
          events.push({
            title: `${samples[i].title} (${loc})`,
            description: samples[i].desc,
            start: d.toISOString(),
            location: loc,
            url: 'https://www.cursor.com',
            fee: samples[i].fee,
            requirements: 'Demo placeholder — use Search with a Ticketmaster key for live results.',
            info: 'Interstellar demo mode',
            source: 'demo',
          });
        }
        return {
          events,
          source: 'demo',
          hint: tmKey ? 'No free/low-cost Ticketmaster hits for this area and window; showing demos.' : 'Add a Ticketmaster Discovery API key for live events (optional).',
        };
      };

      if (!tmKey || Number.isNaN(lat) || Number.isNaN(lng)) {
        return sendJSON(res, 200, demo());
      }

      const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(tmKey)}&latlong=${lat},${lng}&radius=40&unit=miles&startDateTime=${encodeURIComponent(isoStart)}&endDateTime=${encodeURIComponent(isoEnd)}&size=50&classificationName=community,arts,music,family,film`;
      let tmData;
      try {
        tmData = await httpsGetJson(tmUrl);
      } catch (e) {
        console.warn('Ticketmaster:', e.message);
        return sendJSON(res, 200, demo());
      }
      const raw = (tmData && tmData._embedded && tmData._embedded.events) || [];
      const mapped = raw.map((ev) => {
        const start = ev.dates && ev.dates.start && (ev.dates.start.dateTime || ev.dates.start.localDate);
        const venue = ev._embedded && ev._embedded.venues && ev._embedded.venues[0];
        const loc = venue ? [venue.name, venue.city && venue.city.name, venue.state && venue.state.stateCode].filter(Boolean).join(', ') : (city || '');
        let fee = 'See listing';
        if (ev.priceRanges && ev.priceRanges[0]) {
          const pr = ev.priceRanges[0];
          fee = pr.min === 0 && pr.max === 0 ? 'Free' : `$${pr.min}–${pr.max}`;
        }
        const blob = `${ev.name || ''} ${(ev.info && ev.info.pleaseNote) || ''}`.toLowerCase();
        const cheap = ev.priceRanges && ev.priceRanges[0] && Number(ev.priceRanges[0].max) <= 25;
        const freeish = blob.includes('free') || fee === 'Free' || cheap;
        return {
          title: ev.name || 'Event',
          description: (ev.info && ev.info.pleaseNote) || (ev.description && ev.description) || '',
          start: start || '',
          location: loc,
          url: ev.url || '',
          fee,
          requirements: (ev.pleaseNote) || '',
          info: (ev.classifications && ev.classifications[0] && ev.classifications[0].segment && ev.classifications[0].segment.name) || '',
          source: 'ticketmaster',
          _freeish: freeish,
        };
      });
      const prefer = mapped.filter((e) => e._freeish).map((e) => {
        const o = Object.assign({}, e);
        delete o._freeish;
        return o;
      });
      let out = prefer;
      if (out.length === 0) {
        out = mapped.slice(0, 18).map((e) => {
          const o = Object.assign({}, e);
          delete o._freeish;
          return o;
        });
      }
      if (out.length === 0) return sendJSON(res, 200, demo());
      return sendJSON(res, 200, {
        events: out,
        source: 'ticketmaster',
        hint: prefer.length ? '' : 'Including general listings (no free filter matched).',
      });
    } catch (e) {
      console.error('interstellar-events:', e);
      return sendJSON(res, 500, { error: 'Search failed', events: [], source: 'error' });
    }
  }

  const agentsDataPath = p.match(/^\/api\/agents-data\/([^/]+)$/);
  if (agentsDataPath && req.method === 'GET') {
    const username = sanitize(decodeURIComponent(agentsDataPath[1]));
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    try {
      const data = readAgentsArchiveForUser(username);
      sendJSON(res, 200, data);
    } catch (e) {
      sendJSON(res, 500, { error: 'read agents failed' });
    }
    return;
  }
  if (agentsDataPath && req.method === 'POST') {
    const username = sanitize(decodeURIComponent(agentsDataPath[1]));
    if (!username) return sendJSON(res, 400, { error: 'Invalid username' });
    try {
      const body = await readBody(req);
      writeAgentsArchiveForUser(username, body);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message || 'write agents failed' });
    }
    return;
  }

  const spFileMatch = p.match(/^\/api\/savepoint-file\/([^/]+)\/(.+)$/);
  if (spFileMatch && req.method === 'GET') {
    const username = sanitize(decodeURIComponent(spFileMatch[1]));
    let filename = path.basename(decodeURIComponent(spFileMatch[2]));
    if (!username || !filename.endsWith('.json') || !filename.includes('_sp_')) {
      return sendJSON(res, 400, { error: 'Invalid path' });
    }
    filename = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!listSavepointFilesForUser(username).includes(filename)) {
      return sendJSON(res, 404, { error: 'Not found' });
    }
    try {
      const fp = path.join(SAVEPOINT_DIR, filename);
      sendJSON(res, 200, JSON.parse(fs.readFileSync(fp, 'utf-8')));
    } catch (e) { sendJSON(res, 500, { error: 'Read failed' }); }
    return;
  }

  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.join(REPO_ROOT, filePath);
  if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try { const content = fs.readFileSync(filePath); res.writeHead(200, { 'Content-Type': mime }); res.end(content); }
  catch { res.writeHead(404); res.end('Not Found'); }
});

/* ── Interactive PTY over WebSocket: /ws/terminal ──
   Client sends raw shell input as binary frames; control messages
   ({type:'resize',cols,rows}) come as text frames. Server forwards bytes
   between the WebSocket and a PTY-attached shell. Loopback only. */
let wssTerminal = null;
if (WSServer && nodePty) {
  wssTerminal = new WSServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let urlObj;
    try { urlObj = new URL(req.url, `http://localhost:${PORT}`); } catch (_) { socket.destroy(); return; }
    if (urlObj.pathname !== '/ws/terminal') { socket.destroy(); return; }
    if (!isLoopbackRequest(req)) { socket.destroy(); return; }
    // Pass through the query — handlePtySession needs ?slug=<slug> to scope HISTFILE.
    wssTerminal.handleUpgrade(req, socket, head, (ws) => { handlePtySession(ws, urlObj); });
  });
} else {
  server.on('upgrade', (req, socket) => { socket.destroy(); });
}

/** Read the PTY child process's current working directory. macOS uses lsof, Linux uses
 *  /proc/<pid>/cwd. Returns null on Windows or if the lookup fails. */
function readPtyCwd(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'linux') {
      return fs.readlinkSync('/proc/' + pid + '/cwd');
    }
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'], { timeout: 1200 }).toString();
      const m = out.match(/^n(.+)$/m);
      return m ? m[1].trim() : null;
    }
  } catch (_) { /* shell exited / lsof not available — fine */ }
  return null;
}

/** Async variant of readPtyCwd — identical result, but never blocks the event loop.
 *  On macOS the sync lsof subprocess (run once per shell every 1.5s) stalls the single
 *  Node event loop that also forwards PTY output and serves /api/data saves, so with
 *  several terminals open the whole app feels laggy. execFile keeps the lookup off the
 *  main thread; the sync readPtyCwd above is kept intact for any other/legacy caller. */
function readPtyCwdAsync(pid, cb) {
  if (!pid) return cb(null);
  try {
    if (process.platform === 'linux') {
      return fs.readlink('/proc/' + pid + '/cwd', (err, res) => cb(err ? null : res));
    }
    if (process.platform === 'darwin') {
      const { execFile } = require('child_process');
      return execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'], { timeout: 1200 }, (err, stdout) => {
        if (err || !stdout) return cb(null);
        const m = stdout.toString().match(/^n(.+)$/m);
        cb(m ? m[1].trim() : null);
      });
    }
  } catch (_) { /* shell exited / lsof not available — fine */ }
  return cb(null);
}

/* PTY session pool — keep shells alive across WebSocket drops and reattach by slug.
   A transient disconnect (laptop sleep, backgrounded tab, network blip) detaches the
   socket but KEEPS the shell running and buffers its output; the client reconnects with
   the same ?slug= and reattaches to the very same shell. The shell is killed only when:
   the client explicitly asks ({type:'kill'} sent by Restart/Close), the shell exits on
   its own, or — as a leak guard — the pool exceeds a cap and an idle detached shell is
   evicted. Slug-less (legacy) connections stay ephemeral (killed on close, as before). */
const PTY_DETACH_BUFFER_CAP = 512 * 1024; // bytes of output retained while detached
const PTY_HEARTBEAT_MS = 20000;           // ping cadence; browsers auto-pong at protocol level
const PTY_MAX_MISSED_PONGS = 3;           // grace: only terminate a socket after this many silent cycles (~60s),
                                          // so a momentarily-throttled/busy tab isn't dropped on a single miss
const PTY_POOL_MAX = 40;                  // safety cap on simultaneous shells
const ptyPool = new Map();    // slug -> entry (only slugged sessions can be reattached)
const ptyEntries = new Set(); // every live entry (pooled + transient), for the heartbeat sweep

function ptyBufferPush(entry, chunk) {
  entry.buffer.push(chunk);
  entry.bufferBytes += Buffer.byteLength(chunk);
  while (entry.bufferBytes > PTY_DETACH_BUFFER_CAP && entry.buffer.length > 1) {
    entry.bufferBytes -= Buffer.byteLength(entry.buffer.shift());
  }
}

function ptyAttach(entry, ws) {
  if (entry.ws && entry.ws !== ws) { try { entry.ws.terminate(); } catch (_) {} } // newer socket wins
  entry.ws = ws;
  entry.wsAlive = true;
  entry.missedPings = 0;
  entry.detached = false;
  if (entry.buffer.length) { // flush output produced while detached, in order
    for (const c of entry.buffer) { try { ws.send(c); } catch (_) {} }
    entry.buffer = []; entry.bufferBytes = 0;
  }
  if (entry.lastCwd) { try { ws.send(JSON.stringify({ type: 'cwd', cwd: entry.lastCwd })); } catch (_) {} }
}

function ptyDestroy(entry) {
  if (!entry || entry.destroyed) return;
  entry.destroyed = true;
  try { clearInterval(entry.cwdTimer); } catch (_) {}
  try { entry.pty.kill(); } catch (_) {}
  try { if (entry.ws) entry.ws.close(); } catch (_) {}
  if (entry.slug) ptyPool.delete(entry.slug);
  ptyEntries.delete(entry);
}

function ptyEvictIfOverCap() {
  if (ptyPool.size <= PTY_POOL_MAX) return;
  let victim = null; // only ever evict an idle, currently-detached shell
  for (const e of ptyPool.values()) {
    if (e.detached && (!victim || e.detachedAt < victim.detachedAt)) victim = e;
  }
  if (victim) ptyDestroy(victim);
}

function ptyReadSlug(urlObj) {
  try {
    const s = urlObj && urlObj.searchParams ? urlObj.searchParams.get('slug') : '';
    return (s && /^[a-z0-9_-]{1,48}$/i.test(s)) ? s : '';
  } catch (_) { return ''; }
}

function handlePtySession(ws, urlObj) {
  const slug = ptyReadSlug(urlObj);

  // Reattach to the still-running shell for this slug if one is pooled.
  if (slug && ptyPool.has(slug)) {
    const entry = ptyPool.get(slug);
    if (!entry.destroyed) { ptyAttach(entry, ws); bindPtyWs(entry, ws); return; }
  }

  // Otherwise spawn a fresh shell. Per-agent HISTFILE so up-arrow recall stays isolated.
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'powershell.exe') : (process.env.SHELL || '/bin/zsh');
  const histEnv = {};
  if (slug) {
    try {
      const histDir = path.join(DATA_DIR, '_shell_history');
      fs.mkdirSync(histDir, { recursive: true });
      const histPath = path.join(histDir, slug + '.history');
      try { fs.closeSync(fs.openSync(histPath, 'a')); } catch (_) {}
      histEnv.HISTFILE = histPath; histEnv.HISTSIZE = '10000'; histEnv.SAVEHIST = '10000';
    } catch (_) { /* keep going with default history */ }
  }
  let pty;
  try {
    pty = nodePty.spawn(shell, isWin ? [] : ['-l'], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, histEnv),
    });
  } catch (e) {
    try { ws.send(`\r\n[error: failed to spawn shell: ${e.message}]\r\n`); } catch (_) {}
    try { ws.close(); } catch (_) {}
    return;
  }

  const entry = {
    slug, pty, ws, wsAlive: true, missedPings: 0, detached: false, destroyed: false,
    buffer: [], bufferBytes: 0, lastCwd: null, detachedAt: 0, cwdTimer: null,
  };
  ptyEntries.add(entry);
  if (slug) { ptyPool.set(slug, entry); ptyEvictIfOverCap(); }

  // cwd poller — forward changes to whichever socket is currently attached.
  // Uses the async reader with an in-flight guard so a slow lsof never blocks the
  // event loop, and calls can't pile up when many shells are open.
  entry.cwdTimer = setInterval(() => {
    if (entry.destroyed || entry.cwdBusy) return;
    entry.cwdBusy = true;
    readPtyCwdAsync(pty.pid, (cwd) => {
      entry.cwdBusy = false;
      if (entry.destroyed) return;
      if (cwd && cwd !== entry.lastCwd) {
        entry.lastCwd = cwd;
        if (entry.ws && !entry.detached) { try { entry.ws.send(JSON.stringify({ type: 'cwd', cwd })); } catch (_) {} }
      }
    });
  }, 1500);

  pty.onData((d) => {
    if (entry.ws && !entry.detached) { try { entry.ws.send(d); } catch (_) { ptyBufferPush(entry, d); } }
    else ptyBufferPush(entry, d);
  });
  pty.onExit(() => {
    try { if (entry.ws && !entry.detached) { entry.ws.send('\r\n[shell exited]\r\n'); entry.ws.send(JSON.stringify({ type: 'exit' })); } } catch (_) {}
    ptyDestroy(entry);
  });

  bindPtyWs(entry, ws);
}

/** Wire a websocket to a pty entry: input, control frames, heartbeat liveness, detach-on-close. */
function bindPtyWs(entry, ws) {
  // Any inbound frame proves the socket is alive: a protocol pong, raw shell input, OR the
  // client's own {type:'ping'} keepalive. This means a connected-but-idle tab whose pongs are
  // briefly delayed still counts as alive as long as it's sending its keepalive.
  const markAlive = () => { if (entry.ws === ws) { entry.wsAlive = true; entry.missedPings = 0; } };
  ws.on('pong', markAlive);
  ws.on('message', (data, isBinary) => {
    markAlive();
    try {
      if (!isBinary) {
        // Text frame — JSON control message.
        let m; try { m = JSON.parse(data.toString('utf8')); } catch (_) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.type === 'resize' && m.cols && m.rows) {
          try { entry.pty.resize(Math.max(2, m.cols | 0), Math.max(2, m.rows | 0)); } catch (_) {}
        } else if (m.type === 'kill') {
          ptyDestroy(entry); // explicit user action (Restart/Close) — actually end the shell
        }
        // {type:'ping'} (client keepalive) and anything else: ignore.
        return;
      }
      entry.pty.write(data); // binary frame — raw shell input
    } catch (_) { /* ignore one bad frame */ }
  });
  const onGone = () => {
    if (entry.destroyed) return;
    if (entry.ws !== ws) return; // a newer socket already took over this entry
    if (entry.slug) {
      // Keep the shell alive; buffer its output until the client reconnects with the same slug.
      entry.detached = true; entry.detachedAt = Date.now(); entry.ws = null;
    } else {
      ptyDestroy(entry); // legacy slug-less session — nothing can reattach, so end it
    }
  };
  ws.on('close', onGone);
  ws.on('error', onGone);
}

/* Heartbeat: ping each attached socket; browsers auto-reply with pong. A socket that
   misses a full cycle is terminated, which DETACHES it (the shell keeps running and
   buffers output) so the client's reconnect can reattach — the shell is never killed here. */
const ptyHeartbeat = setInterval(() => {
  for (const entry of ptyEntries) {
    const ws = entry.ws;
    if (!ws || entry.detached) continue;
    if (entry.wsAlive === false) {
      // No pong/inbound frame since the last cycle. Allow a grace window before giving up —
      // a single missed beat is usually just a throttled/busy tab, not a dead client. Only a
      // genuinely silent socket reaches the cap, and terminating it merely DETACHES (the shell
      // keeps running + buffering) so the client's reconnect reattaches to the same shell.
      entry.missedPings = (entry.missedPings || 0) + 1;
      if (entry.missedPings >= PTY_MAX_MISSED_PONGS) { try { ws.terminate(); } catch (_) {} continue; }
    } else {
      entry.missedPings = 0;
    }
    entry.wsAlive = false; // flipped back to true by the next pong or any inbound frame
    try { ws.ping(); } catch (_) {}
  }
}, PTY_HEARTBEAT_MS);
if (ptyHeartbeat.unref) ptyHeartbeat.unref();

ghHydrateDataDir().then(() => {
  server.listen(PORT, () => {
    syncPrepareArtifactsFromDisk();
    console.log(`\n🌐 My Cosmos`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   Data: ${DATA_DIR}`);
    if (PUBLIC_MODE) console.log(`   Mode: PUBLIC (auth enforced, local-only pages/APIs disabled)`);
    if (GH_ENABLED) console.log(`   GitHub sync: ${GH_REPO}@${GH_BRANCH}`);
    if (!process.env.MY_COSMOS_DATA && !process.env.PROGRESS_TRACKER_DATA) {
      console.log(`   (project data/ — set MY_COSMOS_DATA to use another folder)`);
    }
    if (process.env.MY_COSMOS_EMBED_PRELOAD === '1' || process.env.PROGRESS_TRACKER_EMBED_PRELOAD === '1') {
      console.log(`   Preload: embedding first *_data.json into index.html on save`);
    }
    console.log(`   Savepoints: ${SAVEPOINT_DIR}\n`);
  });
});

/* Hosted platforms send SIGTERM on redeploy/restart — flush pending GitHub pushes first. */
process.on('SIGTERM', () => {
  if (!GH_ENABLED) process.exit(0);
  console.log('SIGTERM — flushing GitHub sync before exit…');
  Promise.race([ghFlushAllNow(), new Promise(r => setTimeout(r, 8000))]).then(() => process.exit(0));
});
