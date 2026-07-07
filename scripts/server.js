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
const zlib = require('zlib');
const { spawn } = require('child_process');

/* Optional deps — required only for the in-app interactive Terminal column.
   Server still boots if they're missing (terminal column degrades to a clear error). */
let nodePty = null;
let WSServer = null;
try { nodePty = require('node-pty'); } catch (_) { /* terminal column will report missing dep */ }
try { WSServer = require('ws').WebSocketServer; } catch (_) { /* same */ }

/* Keep the process alive on stray async errors. Node exits by default on an
   unhandled promise rejection, which on a hosted single-instance deployment
   shows up as brief `x-render-routing: no-server` blips while the container
   restarts. Log and continue instead — a personal/demo server should stay up. */
process.on('unhandledRejection', (err) => { console.error('unhandledRejection:', (err && err.stack) || err); });
process.on('uncaughtException', (err) => { console.error('uncaughtException:', (err && err.stack) || err); });

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

/** True if the client advertised gzip support (browsers always do). */
function acceptsGzip(req) { return /\bgzip\b/i.test(String((req && req.headers && req.headers['accept-encoding']) || '')); }

/** End a response with an optional gzip pass. Only compresses reasonably large
 *  bodies (small ones aren't worth the CPU/latency). Falls back to plain on error. */
function endMaybeGzip(req, res, status, headers, buf) {
  headers = Object.assign({ 'Vary': 'Accept-Encoding' }, headers);
  if (buf.length >= 1400 && acceptsGzip(req)) {
    try {
      const gz = zlib.gzipSync(buf, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(status, headers);
      res.end(gz);
      return;
    } catch (_) { /* fall through to uncompressed */ }
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

/** JSON responder that gzips big payloads (e.g. the multi-MB /api/data graph).
 *  Uses an mtime-keyed cache so a user reloading the same graph doesn't re-compress. */
function sendJSONZ(req, res, status, data) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  endMaybeGzip(req, res, status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  }, buf);
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
          // Make collaboration functional, not just visual: mirror a brief of every
          // linked collaborator's goal/skills/project structure into this agent's
          // project dir (COLLABORATORS.md + a marked pointer block in CLAUDE.md,
          // which Claude Code auto-loads at session start).
          syncCollabBriefForTerminalAgent(slug, d, agents, graph);
        }
      } catch (_) { /* project-dir mirror is best-effort */ }
    }
  });
  return { ok: true };
}

/* ── Collaborator briefs ──
   An agent's crew-deck collaboration links (shift-click bridges in graph.edges +
   the directed rec.collaborators list) previously only drew bridges between
   islands. These helpers make the link functional for terminal (Claude Code)
   agents: each linked agent's goal, approach, Claude Code skills/commands, and a
   depth-limited project tree are written to <project>/COLLABORATORS.md, and a
   marked, auto-managed block in <project>/CLAUDE.md points at it so the agent
   knows about its collaborators from the first token of every session. */
const COLLAB_BRIEF_MARKER = '<!-- auto-generated by My Cosmos: collaborator brief -->';
const COLLAB_BLOCK_START = '<!-- my-cosmos:collaborators start -->';
const COLLAB_BLOCK_END = '<!-- my-cosmos:collaborators end -->';
const COLLAB_BRIEF_TTL_MS = 10 * 60 * 1000; // rescan collaborator projects at most every 10 min
const _collabBriefCache = new Map(); // slug → {key, ts}
const COLLAB_SCAN_SKIP = new Set(['node_modules', '__pycache__', 'venv', 'dist', 'build']);

/** Depth-limited, entry-capped tree of a project dir (skips dot/vendored dirs). */
function collabScanProjectTree(dir) {
  const lines = [];
  let count = 0;
  const MAX_LINES = 120;
  const walk = (d, prefix, depth) => {
    if (count >= MAX_LINES) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    ents = ents.filter((e) => !e.name.startsWith('.') && !COLLAB_SCAN_SKIP.has(e.name));
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const cap = depth === 0 ? 24 : 10;
    const shown = ents.slice(0, cap);
    for (const e of shown) {
      if (count >= MAX_LINES) { lines.push(prefix + '…'); return; }
      if (e.isDirectory()) {
        lines.push(prefix + e.name + '/'); count++;
        if (depth < 2) walk(path.join(d, e.name), prefix + '  ', depth + 1);
      } else { lines.push(prefix + e.name); count++; }
    }
    if (ents.length > shown.length) { lines.push(prefix + '… (' + (ents.length - shown.length) + ' more)'); count++; }
  };
  walk(dir, '', 0);
  return lines.join('\n');
}

/** Claude Code assets of a project: skills, commands, custom agents. */
function collabListClaudeAssets(dir) {
  const out = [];
  for (const sub of ['.claude/skills', '.claude/commands', '.claude/agents']) {
    try {
      const p = path.join(dir, sub);
      if (fs.existsSync(p)) fs.readdirSync(p).slice(0, 24).forEach((n) => out.push(sub + '/' + n));
    } catch (_) { /* ignore */ }
  }
  return out;
}

/** Insert/replace/remove the marker-delimited collaborator block in a text file.
 *  blockText=null removes the block (and deletes the file if nothing else remains). */
function upsertManagedBlock(filePath, blockText) {
  let cur = '';
  try { cur = fs.readFileSync(filePath, 'utf8'); } catch (_) { cur = ''; }
  const s = cur.indexOf(COLLAB_BLOCK_START);
  let next;
  if (blockText == null) {
    if (s < 0) return;
    const e = cur.indexOf(COLLAB_BLOCK_END, s);
    if (e < 0) return;
    next = (cur.slice(0, s) + cur.slice(e + COLLAB_BLOCK_END.length)).replace(/\n{3,}/g, '\n\n');
    if (!next.trim()) { try { fs.unlinkSync(filePath); } catch (_) {} return; }
  } else {
    const block = COLLAB_BLOCK_START + '\n' + blockText.trim() + '\n' + COLLAB_BLOCK_END;
    if (s >= 0) {
      const e = cur.indexOf(COLLAB_BLOCK_END, s);
      if (e < 0) return; // malformed markers — leave the user's file alone
      next = cur.slice(0, s) + block + cur.slice(e + COLLAB_BLOCK_END.length);
    } else {
      next = (cur.trim() ? cur.replace(/\s*$/, '\n\n') : '') + block + '\n';
    }
  }
  if (next !== cur) atomicWriteFileSync(filePath, next);
}

function syncCollabBriefForTerminalAgent(slug, d, agents, graph) {
  const cwd = d.lastCwd;
  // Linked = directed collaborators ∪ shift-click bridge edges, so a bridge drawn
  // on the crew deck is functional, not just decorative.
  const linked = new Set(Array.isArray(d.collaborators) ? d.collaborators : []);
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  edges.forEach((e) => {
    if (!e) return;
    if (e.source === slug && typeof e.target === 'string') linked.add(e.target);
    if (e.target === slug && typeof e.source === 'string') linked.add(e.source);
  });
  linked.delete(slug);
  const collabs = [...linked].sort().map((s) => {
    const r = agents[s];
    return (r && typeof r === 'object') ? { slug: s, rec: r } : null;
  }).filter(Boolean);
  const key = JSON.stringify([cwd, collabs.map((c) => [c.slug, c.rec.name || '', c.rec.lastCwd || '',
    String(c.rec.goalMd || '').length, String(c.rec.approachMd || '').length])]);
  const cached = _collabBriefCache.get(slug);
  const now = Date.now();
  if (cached && cached.key === key && (now - cached.ts) < COLLAB_BRIEF_TTL_MS) return;
  _collabBriefCache.set(slug, { key, ts: now });
  const briefPath = path.join(cwd, 'COLLABORATORS.md');
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (!collabs.length) {
    // Collaborations were removed — clean up our auto-generated artifacts only.
    try {
      if (fs.existsSync(briefPath) && fs.readFileSync(briefPath, 'utf8').includes(COLLAB_BRIEF_MARKER)) {
        fs.unlinkSync(briefPath);
      }
    } catch (_) { /* ignore */ }
    try { upsertManagedBlock(claudeMdPath, null); } catch (_) { /* ignore */ }
    return;
  }
  const ownName = d.name || slug;
  const sections = collabs.map(({ slug: cslug, rec }) => {
    const name = rec.name || cslug;
    const cdir = (typeof rec.lastCwd === 'string' && rec.lastCwd && path.isAbsolute(rec.lastCwd)) ? rec.lastCwd : '';
    const lines = ['## ' + name];
    if (cdir) lines.push('- Project (read-only for you): `' + cdir + '`');
    else lines.push('- Project: (no working directory known yet — it appears once that agent\'s terminal runs)');
    const goal = String(rec.goalMd || '').trim();
    const appr = String(rec.approachMd || '').trim();
    if (goal) lines.push('- Their goal: ' + goal.slice(0, 600).replace(/\s+/g, ' '));
    if (appr) lines.push('- Their approach: ' + appr.slice(0, 600).replace(/\s+/g, ' '));
    if (cdir && cdir !== cwd) {
      try {
        if (fs.existsSync(cdir) && fs.statSync(cdir).isDirectory()) {
          const assets = collabListClaudeAssets(cdir);
          if (assets.length) lines.push('- Claude Code skills/commands/agents:\n' + assets.map((a) => '  - `' + cdir + '/' + a + '`').join('\n'));
          const tree = collabScanProjectTree(cdir);
          if (tree) lines.push('- Project structure (top levels):\n```\n' + tree + '\n```');
        }
      } catch (_) { /* unreadable collaborator dir — keep the textual info */ }
    } else if (cdir && cdir === cwd) {
      lines.push('- Works in the SAME project directory as you.');
    }
    return lines.join('\n');
  });
  const brief = COLLAB_BRIEF_MARKER + '\n' +
    '# Collaborators of ' + ownName + '\n\n' +
    'These agents are your read-only collaborators. When your current task could benefit from their\n' +
    'scripts, skills, data conventions, or results, read their files directly at the absolute paths\n' +
    'below (e.g. their CLAUDE.md / README / scripts). Never modify their projects.\n\n' +
    sections.join('\n\n') + '\n';
  try { atomicWriteFileSync(briefPath, brief); } catch (_) { /* best-effort */ }
  const pointer = '## Collaborators (auto-managed by My Cosmos — do not edit this block)\n' +
    'You collaborate (read-only) with: ' +
    collabs.map(({ slug: cslug, rec }) => (rec.name || cslug) + (rec.lastCwd ? ' (`' + rec.lastCwd + '`)' : '')).join(', ') + '.\n' +
    'Read `./COLLABORATORS.md` for each collaborator\'s goal, skills, and project structure map\n' +
    'before reinventing something they may already have.';
  try { upsertManagedBlock(claudeMdPath, pointer); } catch (_) { /* best-effort */ }
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

/* ── Inline-image externalization (Option A) ───────────────────────────────
   Some accounts embed dozens of base64 images directly in their notes, so a
   27 MB user file can be 96% image bytes. Every tiny text edit then re-pushes
   all 27 MB to GitHub and re-serves it on every online load. This pulls each
   large inline image out into a content-addressed file under <base>/media/ and
   replaces it with a /api/media/<base>/<hash>.<ext> URL. Result: the stored JSON
   shrinks to the text (~1 MB), images are pushed once (hash-deduped, immutable)
   and browsers cache each image forever. Public deployment only — the local app
   keeps images inline so local files stay self-contained and portable. */
const MEDIA_EXT = { png:'png', jpeg:'jpg', jpg:'jpg', gif:'gif', webp:'webp', 'svg+xml':'svg', bmp:'bmp' };
const MEDIA_MIN_B64 = 2048; // skip tiny inline icons — not worth a file each

/** Replace large `data:image/...;base64,...` blobs in a serialized user JSON
 *  with /api/media URLs, writing the bytes to <base>/media/. Never throws:
 *  on any problem it returns the original string unchanged. */
function externalizeInlineImages(base, jsonStr) {
  try {
    if (!jsonStr || jsonStr.indexOf('data:image/') === -1) return { slim: jsonStr, count: 0, bytes: 0 };
    const mediaDir = path.join(DATA_DIR, base, 'media');
    let count = 0, bytes = 0;
    // Linear scan; base64 alphabet ([A-Za-z0-9+/=]) contains no JSON-string
    // metacharacter, so the match never overruns the enclosing JSON string and
    // the replacement (plain URL chars) keeps the JSON valid.
    const re = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g;
    const slim = jsonStr.replace(re, (full, subtype, b64) => {
      try {
        if (b64.length < MEDIA_MIN_B64) return full;
        const ext = MEDIA_EXT[String(subtype).toLowerCase()];
        if (!ext) return full;
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return full;
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const rel = `${base}/media/${hash}.${ext}`;
        const abs = path.join(DATA_DIR, rel);
        if (!abs.startsWith(DATA_DIR)) return full;
        if (!fs.existsSync(abs)) {
          fs.mkdirSync(mediaDir, { recursive: true });
          fs.writeFileSync(abs, buf);
          bytes += buf.length;
        }
        ghQueue(rel); // content-addressed → hash-skip dedupes; pushed at most once
        count++;
        return `/api/media/${base}/${hash}.${ext}`;
      } catch (_) { return full; }
    });
    return { slim, count, bytes };
  } catch (_) { return { slim: jsonStr, count: 0, bytes: 0 }; }
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
   ACCOUNTS & SESSIONS — passwords live in data/auth.json (scrypt hash + salt).
   Sessions are STATELESS, HMAC-signed tokens (no in-memory session table), so
   they survive restarts/redeploys → a signed-in user stays signed in indefinitely.
   Each account carries a rotating `sessionNonce` in auth.json; a token is valid
   only while its nonce still matches. Signing in rotates the nonce, which
   invalidates the token any OTHER device is holding — enforcing one active device
   per account so two devices can't race and clobber each other's data. Auth is
   only ENFORCED when MY_COSMOS_PUBLIC=1; the endpoints exist locally too but
   nothing requires them.
   ═══════════════════════════════════════════════════════════════════════════ */
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const MIN_PASSWORD_LEN = 8;
/** Public-demo account cap: registration is refused once this many accounts exist
 *  (override with MY_COSMOS_MAX_ACCOUNTS). Existing users can always still sign in. */
const MAX_ACCOUNTS = parseInt(process.env.MY_COSMOS_MAX_ACCOUNTS, 10) || 50;
/* ── Two-tier storage (public demo) ─────────────────────────────────────────
   • BETA tier: user redeemed a valid invite PIN → data is persisted server-side
     (and synced to GitHub) up to MAX_USER_MB. PIN_COUNT PINs exist; one PIN maps
     to exactly one account.
   • EPHEMERAL tier: anyone else → the app still works but their graph lives only
     in their own browser; the server keeps just account info (email/name/pass)
     plus last login + total usage. */
const MAX_USER_MB = parseInt(process.env.MY_COSMOS_MAX_USER_MB, 10) || 50;
const MAX_USER_BYTES = MAX_USER_MB * 1024 * 1024;
const PIN_COUNT = parseInt(process.env.MY_COSMOS_PIN_COUNT, 10) || 50;
const ADMIN_TOKEN = process.env.MY_COSMOS_ADMIN_TOKEN || '';
/* Shared secret the local sync watcher uses to push a machine's edits straight to
 * the cloud without a user login (so it can't kick the owner's browser session).
 * Defaults to the admin token so no extra env var is needed. */
const SYNC_TOKEN = process.env.MY_COSMOS_SYNC_TOKEN || ADMIN_TOKEN || '';
const PINS_FILE = path.join(DATA_DIR, 'pins.json');
let _authDb = null;
let _pinsDb = null;

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

/* ── Invite-PIN registry (data/pins.json) ──────────────────────────────────
   Shape: { codes: { "COSMOS-XXXX-XXXX": { account: base|null, redeemedAt } } }.
   Kept in the private data repo (never the public code repo). */
function loadPinsDb() {
  if (_pinsDb) return _pinsDb;
  try { _pinsDb = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch (_) { _pinsDb = null; }
  if (!_pinsDb || typeof _pinsDb !== 'object' || !_pinsDb.codes || typeof _pinsDb.codes !== 'object') {
    _pinsDb = { codes: {} };
  }
  return _pinsDb;
}
function savePinsDb() {
  atomicWriteFileSync(PINS_FILE, JSON.stringify(loadPinsDb(), null, 2));
  ghQueue('pins.json');
}
function normalizePin(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').trim(); }
function genPinCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
  const grp = () => Array.from({ length: 4 }, () => A[crypto.randomBytes(1)[0] % A.length]).join('');
  return `COSMOS-${grp()}-${grp()}`;
}
/** Make sure PIN_COUNT codes exist. Generates missing ones and persists. */
function ensurePins() {
  const db = loadPinsDb();
  let added = 0;
  while (Object.keys(db.codes).length < PIN_COUNT) {
    const c = genPinCode();
    if (!db.codes[c]) { db.codes[c] = { account: null, redeemedAt: null }; added++; }
  }
  if (added) { savePinsDb(); console.log(`🔑 Seeded ${added} invite PIN(s) — ${Object.keys(db.codes).length} total.`); }
  return db;
}

/* ── Email verification (public mode) ──────────────────────────────────────
   Sends account-verification emails via the Resend HTTPS API (same built-in
   `https` transport the GitHub sync uses — still zero npm deps). Verification
   is only REQUIRED when both PUBLIC_MODE and a mail key are set; otherwise
   accounts are auto-verified so local/dev behavior is unchanged. */
const RESEND_KEY = process.env.MY_COSMOS_RESEND_KEY || process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MY_COSMOS_MAIL_FROM || 'My Cosmos <onboarding@resend.dev>';
const MAIL_ENABLED = !!RESEND_KEY;
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const REQUIRE_EMAIL_VERIFY = PUBLIC_MODE && MAIL_ENABLED;

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }
function htmlEscape(s) { return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

/** Public base URL for building verification links. Prefers explicit config, then
 *  Render's injected URL, then the request's forwarded host (works behind Render's proxy). */
function baseUrlFromReq(req) {
  const cfg = (process.env.MY_COSMOS_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (cfg) return cfg.replace(/\/+$/, '');
  const proto = String((req && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() || 'https';
  const host = (req && req.headers.host) || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sendResendEmail(to, subject, html) {
  return new Promise((resolve) => {
    if (!MAIL_ENABLED) { resolve({ ok: false, error: 'email not configured' }); return; }
    const payload = Buffer.from(JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }), 'utf8');
    const r = https.request({
      method: 'POST', hostname: 'api.resend.com', path: '/emails',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (resp) => {
      let b = ''; resp.setEncoding('utf8'); resp.on('data', (c) => { b += c; });
      resp.on('end', () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.setTimeout(20000, () => { try { r.destroy(new Error('email timeout')); } catch (_) {} });
    r.write(payload); r.end();
  });
}

function verificationEmailHtml(firstName, link) {
  const name = firstName ? htmlEscape(firstName) : 'there';
  const safeLink = htmlEscape(link);
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1e1b4b">
    <h2 style="margin:0 0 12px">Welcome to My Cosmos, ${name} 👋</h2>
    <p style="line-height:1.5;color:#374151">Confirm your email address to activate your account.</p>
    <p style="margin:24px 0"><a href="${safeLink}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">Verify my email</a></p>
    <p style="font-size:12px;color:#6b7280;line-height:1.5">Or paste this link into your browser:<br><span style="word-break:break-all">${safeLink}</span></p>
    <p style="font-size:12px;color:#9ca3af;margin-top:24px">This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>
  </div>`;
}

/** Result page shown when the user clicks the verification link. */
function verifyResultHtml(vr, appUrl) {
  const ok = vr && vr.ok;
  const title = ok ? 'Email verified ✓' : (vr && vr.reason === 'expired' ? 'Link expired' : 'Verification failed');
  const msg = ok
    ? 'Your account is now active. You can sign in to My Cosmos.'
    : (vr && vr.reason === 'expired'
      ? 'This verification link has expired. Sign in and use “Resend verification email” to get a fresh one.'
      : 'This verification link is invalid or has already been used.');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">
    <div style="max-width:420px;padding:32px;text-align:center">
      <h1 style="font-size:22px;margin:0 0 12px;color:${ok ? '#a78bfa' : '#fca5a5'}">${title}</h1>
      <p style="line-height:1.5;color:#cbd5e1">${msg}</p>
      <p style="margin-top:24px"><a href="${htmlEscape(appUrl)}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">Go to My Cosmos</a></p>
    </div>
  </body></html>`;
}

/** Issue (or re-issue) a verification token for an account record and email it. */
async function sendVerificationFor(rec, req) {
  const token = crypto.randomBytes(24).toString('hex');
  rec.verifyToken = token;
  rec.verifyExpires = Date.now() + VERIFY_TTL_MS;
  saveAuthDb();
  const link = `${baseUrlFromReq(req)}/api/auth/verify?token=${token}`;
  return sendResendEmail(rec.email, 'Verify your My Cosmos account', verificationEmailHtml(rec.firstName, link));
}

/** Consume a verification token: flips the matching account to verified:true. */
function verifyEmailToken(token) {
  token = String(token || '');
  if (!token) return { ok: false, reason: 'invalid' };
  const db = loadAuthDb();
  for (const rec of Object.values(db.users)) {
    if (rec && rec.verifyToken === token) {
      if (rec.verifyExpires && Date.now() > rec.verifyExpires) return { ok: false, reason: 'expired' };
      rec.verified = true;
      delete rec.verifyToken; delete rec.verifyExpires;
      saveAuthDb();
      return { ok: true };
    }
  }
  return { ok: false, reason: 'invalid' };
}

/* Stable HMAC key for signing session tokens. Prefer an env secret; otherwise
 * persist a generated one in auth.json so it survives restarts (without a stable
 * key, every redeploy would invalidate all tokens and force everyone to re-login). */
function sessionSecret() {
  if (process.env.MY_COSMOS_SESSION_SECRET) return String(process.env.MY_COSMOS_SESSION_SECRET);
  const db = loadAuthDb();
  if (!db.serverSecret) { db.serverSecret = crypto.randomBytes(32).toString('hex'); saveAuthDb(); }
  return db.serverSecret;
}
/* The account's current session nonce. A signed token must carry this exact nonce
 * to be accepted; rotating it (on login/logout) evicts whatever device held the old
 * one. Read is pure — only `rotate` writes. */
function userSessionNonce(base, rotate) {
  const db = loadAuthDb();
  const rec = db.users[base];
  if (!rec) return '';
  if (rotate) { rec.sessionNonce = crypto.randomBytes(12).toString('hex'); saveAuthDb(); }
  return rec.sessionNonce || '';
}
function signSessionToken(base, nonce) {
  const payload = Buffer.from(JSON.stringify({ u: base, n: nonce }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}
/* New login → rotate the nonce (kicking any other device), then sign a token bound
 * to it. No expiry: the session lasts until a login elsewhere or an explicit logout
 * rotates the nonce out from under it. */
function createSession(user) {
  return signSessionToken(user, userSessionNonce(user, true));
}
/** Token comes as an X-Auth-Token header, or ?authtoken= for sendBeacon (which can't set headers). */
function sessionUser(req, url) {
  let token = String(req.headers['x-auth-token'] || '');
  if (!token && url) token = String(url.searchParams.get('authtoken') || '');
  const dot = token.indexOf('.');
  if (dot <= 0) return '';
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (_) { ok = false; }
  if (!ok) return '';
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return ''; }
  if (!data || !data.u) return '';
  const cur = userSessionNonce(data.u, false);
  if (!cur || data.n !== cur) return ''; // a newer login on another device rotated the nonce
  return data.u;
}

/* Basic per-IP limiter for the auth endpoints (public mode only). Uses the LAST
 * X-Forwarded-For hop — the one appended by Render's proxy — which the client
 * cannot spoof (anything the client puts in XFF ends up to the left of it).
 * Falls back to the socket address when there's no proxy (local testing). */
const _authAttempts = new Map(); // ip -> { n, resetAt }
function clientIp(req) {
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown');
}
function authRateLimited(req) {
  const ip = clientIp(req);
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
/** Per-account cloud cap in MB. Beta accounts may carry a `limitMb` override
 *  (e.g. insider accounts); everyone else uses the global MAX_USER_MB. */
function userLimitMb(rec) { return (rec && rec.limitMb) ? rec.limitMb : MAX_USER_MB; }
/** Storage tier + limits summary for API responses. */
function tierInfo(rec) {
  const tier = (rec && rec.tier) === 'beta' ? 'beta' : 'ephemeral';
  const limMb = userLimitMb(rec);
  return {
    tier,
    storageLimitMb: tier === 'beta' ? limMb : 0,
    storageLimitBytes: tier === 'beta' ? limMb * 1024 * 1024 : 0,
    usedBytes: (rec && rec.bytes) || 0,
  };
}
async function handleAuthRegister(body, req) {
  const base = storageBaseKey(sanitize(String((body && body.username) || '')));
  const password = String((body && body.password) || '');
  const email = String((body && body.email) || '').trim();
  const firstName = String((body && body.firstName) || '').trim().slice(0, 60);
  const lastName = String((body && body.lastName) || '').trim().slice(0, 60);
  const pinRaw = String((body && body.pin) || '').trim();
  if (!base || base.length < 2) return { ok: false, error: 'Username needs at least 2 characters (letters, numbers, - or _).' };
  if (base === 'template-user') return { ok: false, error: 'That name is reserved.' };
  if (password.length < MIN_PASSWORD_LEN) return { ok: false, error: `Password needs at least ${MIN_PASSWORD_LEN} characters.` };
  // In the public demo, first/last name + a valid email are always required and
  // tied to the account (verification is a separate, optional layer via Resend).
  if (PUBLIC_MODE) {
    if (!firstName) return { ok: false, error: 'Enter your first name.' };
    if (!lastName) return { ok: false, error: 'Enter your last name.' };
    if (!isValidEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
  }
  const db = loadAuthDb();
  if (db.users[base] || userDataFileExists(base)) return { ok: false, code: 'username_taken', error: 'That username is already taken.' };
  if (email && isValidEmail(email)) {
    const emailLower = email.toLowerCase();
    for (const u of Object.values(db.users)) {
      if (u && u.emailLower === emailLower) return { ok: false, error: 'That email is already registered.' };
    }
  }
  // ── Tier: a valid, unused PIN unlocks persistent (beta) storage. ──
  let tier = 'ephemeral';
  let pinCode = null;
  if (PUBLIC_MODE && pinRaw) {
    const pins = ensurePins();
    pinCode = normalizePin(pinRaw);
    const entry = pins.codes[pinCode];
    if (!entry) return { ok: false, error: 'That invite PIN isn’t valid. Leave it blank to try the demo without cloud backup.' };
    if (entry.account) return { ok: false, error: 'That invite PIN has already been used by another account.' };
    tier = 'beta';
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString(), tier, bytes: 0 };
  if (firstName) rec.firstName = firstName;
  if (lastName) rec.lastName = lastName;
  if (email && isValidEmail(email)) { rec.email = email; rec.emailLower = email.toLowerCase(); }
  if (tier === 'beta' && pinCode) rec.pin = pinCode;
  rec.verified = !REQUIRE_EMAIL_VERIFY; // no-mail / local: auto-verified (preserves prior behavior)
  db.users[base] = rec;
  saveAuthDb();
  if (tier === 'beta' && pinCode) { // bind the PIN to this account
    const pins = ensurePins();
    pins.codes[pinCode] = { account: base, redeemedAt: new Date().toISOString() };
    savePinsDb();
  }
  console.log(`👤 Registered account: ${base} [${tier}]${REQUIRE_EMAIL_VERIFY ? ' (pending email verification)' : ''}`);
  if (REQUIRE_EMAIL_VERIFY) {
    const sent = await sendVerificationFor(rec, req);
    if (!sent.ok) {
      console.warn(`⚠️  Verification email failed for ${base}: ${sent.error || sent.status || ''}`);
      return { ok: true, pendingVerification: true, email, emailSent: false, ...tierInfo(rec),
        error: 'Account created, but the verification email could not be sent. Try “Resend” in a moment.' };
    }
    return { ok: true, pendingVerification: true, email, emailSent: true, ...tierInfo(rec) };
  }
  return { ok: true, username: base, token: createSession(base), ...tierInfo(rec) };
}
function handleAuthLogin(body) {
  const base = storageBaseKey(sanitize(String((body && body.username) || '')));
  const password = String((body && body.password) || '');
  const db = loadAuthDb();
  const rec = db.users[base];
  const fail = { ok: false, error: 'Wrong username or password.' };
  if (!base || !rec) return fail;
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(rec.hash, 'hex'), Buffer.from(hashPassword(password, rec.salt), 'hex'));
  } catch (_) { match = false; }
  if (!match) return fail;
  // Block sign-in until the address is confirmed (only when verification is active).
  if (REQUIRE_EMAIL_VERIFY && rec.verified === false) {
    return { ok: false, needVerify: true, error: 'Please verify your email before signing in. Check your inbox, or resend the link below.' };
  }
  rec.lastLogin = new Date().toISOString();
  saveAuthDb();
  return { ok: true, username: base, token: createSession(base), ...tierInfo(rec) };
}
/** Resend a verification link. Always returns ok so it never reveals which usernames exist. */
async function handleAuthResend(body, req) {
  const base = storageBaseKey(sanitize(String((body && body.username) || '')));
  const rec = loadAuthDb().users[base];
  if (!rec || rec.verified !== false || !rec.email || !MAIL_ENABLED) return { ok: true };
  const sent = await sendVerificationFor(rec, req);
  return { ok: true, emailSent: !!sent.ok };
}
function removeAuthUser(base) {
  const db = loadAuthDb();
  // Dropping the record removes its sessionNonce too, so any live token stops validating.
  if (db.users[base]) { delete db.users[base]; saveAuthDb(); }
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
  const owner = p.match(/^\/api\/(?:data|savepoint|savepoints|savepoint-file|agents-data|usage)\/([^/]+)/);
  if (owner) {
    let uname = owner[1];
    try { uname = decodeURIComponent(uname); } catch (_) { /* keep raw */ }
    const base = storageBaseKey(sanitize(uname));
    // A trusted local sync watcher may present the sync token (X-Sync-Token) instead
    // of a user session. It writes straight through — bypassing the single-device
    // session check — so mirroring a machine's edits up to the cloud never rotates
    // the nonce and never kicks the owner's online browser. See scripts/sync-to-cloud.js.
    const syncTok = String(req.headers['x-sync-token'] || url.searchParams.get('synctoken') || '');
    if (SYNC_TOKEN && syncTok && syncTok === SYNC_TOKEN) return false; // authorized sync → allow through
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
const _ghContentHash = new Map(); // relPath -> sha1 of the bytes last pushed (skip identical re-uploads)
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
  const buf = fs.readFileSync(abs);
  // Skip the upload entirely if these exact bytes were already pushed. Autosaves,
  // identical re-saves, and the local sync daemon re-sending an unchanged file would
  // otherwise re-upload the whole thing (base64 ≈ 1.33× size) as billable egress.
  // Safe: the file is already on disk + already identical on GitHub, so serving and
  // syncing are unaffected — we only avoid a redundant commit.
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  if (_ghContentHash.get(relPath) === hash) return true; // unchanged → no commit, no egress
  const content = buf.toString('base64');
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
    _ghContentHash.set(relPath, hash);
    return true;
  }
  console.warn(`⚠️  GitHub sync failed for ${relPath}: HTTP ${r.status} ${(r.body && r.body.message) || ''}`);
  return false;
}
async function ghDeleteFile(relPath) {
  const sha = _ghShaCache.get(relPath) || await ghFetchSha(relPath);
  if (!sha) return true; // nothing on the remote
  const r = await ghApi('DELETE', ghContentsPath(relPath), { message: `delete ${relPath}`, sha, branch: GH_BRANCH });
  if (r.status === 200) { _ghShaCache.delete(relPath); _ghContentHash.delete(relPath); return true; }
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

/** On-demand hydrate of a single repo file into DATA_DIR. Used when a media file
 *  is requested before boot hydration has fetched it (Render disk is ephemeral):
 *  we know from the boot tree scan whether the blob exists in the repo, so we can
 *  pull just that one blob and serve it — no cold-cache gap. Returns true if the
 *  file is present on disk afterwards. Never throws. */
const _ghHydrateOneInflight = new Map(); // rel -> Promise (coalesce concurrent misses)
async function ghHydrateOne(rel) {
  try {
    if (!GH_ENABLED || !rel || rel.includes('..')) return false;
    const abs = path.join(DATA_DIR, rel);
    if (!abs.startsWith(DATA_DIR)) return false;
    if (fs.existsSync(abs)) return true;
    if (_ghHydrateOneInflight.has(rel)) return _ghHydrateOneInflight.get(rel);
    const work = (async () => {
      try {
        let blobSha = _ghShaCache.get(rel);
        if (!blobSha) {
          const meta = await ghApi('GET', `${ghContentsPath(rel)}?ref=${encodeURIComponent(GH_BRANCH)}`);
          if (meta.status === 200 && meta.body && meta.body.sha) blobSha = meta.body.sha;
        }
        if (!blobSha) return false;
        const blob = await ghApi('GET', `/repos/${GH_REPO}/git/blobs/${blobSha}`);
        if (blob.status !== 200 || !blob.body || typeof blob.body.content !== 'string') return false;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(blob.body.content, 'base64'));
        _ghShaCache.set(rel, blobSha);
        return fs.existsSync(abs);
      } catch (_) { return false; }
      finally { _ghHydrateOneInflight.delete(rel); }
    })();
    _ghHydrateOneInflight.set(rel, work);
    return work;
  } catch (_) { return false; }
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
      ? { ok: true, port: PORT, publicMode: true, emailVerify: REQUIRE_EMAIL_VERIFY }
      : { ok: true, port: PORT, dataDir: DATA_DIR, agentsLocalApi: true, publicMode: false });
    return;
  }

  // ── Accounts (register / login / logout / whoami) ──
  if (p.startsWith('/api/auth/')) {
    if (PUBLIC_MODE && authRateLimited(req)) {
      sendJSON(res, 429, { ok: false, error: 'Too many attempts — try again in a few minutes.' });
      return;
    }
    // Verify link is clicked from an email (GET) — return a friendly HTML page, not JSON.
    if (p === '/api/auth/verify' && req.method === 'GET') {
      const vr = verifyEmailToken(url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(verifyResultHtml(vr, `${baseUrlFromReq(req)}/index.html`));
      return;
    }
    try {
      if (p === '/api/auth/register' && req.method === 'POST') { sendJSON(res, 200, await handleAuthRegister(await readBody(req), req)); return; }
      if (p === '/api/auth/login' && req.method === 'POST') { sendJSON(res, 200, handleAuthLogin(await readBody(req))); return; }
      if (p === '/api/auth/resend' && req.method === 'POST') { sendJSON(res, 200, await handleAuthResend(await readBody(req), req)); return; }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const su = sessionUser(req, url);
        if (su) userSessionNonce(su, true); // rotate → this token is now invalid everywhere
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/auth/whoami' && req.method === 'GET') {
        const su = sessionUser(req, url);
        if (!su) { sendJSON(res, 200, { ok: false }); return; }
        const rec = loadAuthDb().users[su];
        sendJSON(res, 200, { ok: true, username: su, ...tierInfo(rec) });
        return;
      }
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'Bad request' });
      return;
    }
    sendJSON(res, 404, { ok: false, error: 'Unknown auth endpoint' });
    return;
  }

  // ── Usage ping (ephemeral accounts report browser-side data size) ──
  if (p.startsWith('/api/usage/') && req.method === 'POST') {
    const username = storageBaseKey(sanitize(p.replace(/^\/api\/usage\//, '').split('/')[0]));
    try {
      const body = await readBody(req);
      const bytes = Math.max(0, parseInt(body && body.bytes, 10) || 0);
      const rec = loadAuthDb().users[username];
      if (rec) { rec.bytes = bytes; rec.lastLogin = new Date().toISOString(); saveAuthDb(); }
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 200, { ok: true }); }
    return;
  }

  // ── Admin: invite-PIN registry (token-protected JSON) ──
  // GET /api/admin/pins?token=…  → { limitMb, pins:[{pin,account,tier,email,name,redeemedAt,lastLogin,usedBytes,usedMb}] }
  if (p === '/api/admin/pins' && req.method === 'GET') {
    const token = String(url.searchParams.get('token') || req.headers['x-admin-token'] || '');
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) { sendJSON(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const pins = ensurePins();
    const users = loadAuthDb().users;
    const rows = Object.keys(pins.codes).sort().map((code) => {
      const e = pins.codes[code] || {};
      const rec = e.account ? users[e.account] : null;
      const name = rec ? [rec.firstName, rec.lastName].filter(Boolean).join(' ') : '';
      return {
        pin: code, account: e.account || null, redeemedAt: e.redeemedAt || null,
        tier: rec ? (rec.tier || 'beta') : null, email: rec ? (rec.email || null) : null,
        name: name || null, lastLogin: rec ? (rec.lastLogin || null) : null,
        usedBytes: rec ? (rec.bytes || 0) : 0, usedMb: rec ? +(((rec.bytes || 0) / 1048576).toFixed(2)) : 0,
      };
    });
    // Also surface ephemeral (no-PIN) accounts so the whole roster is visible.
    const ephemeral = Object.keys(users).filter((u) => (users[u].tier || 'ephemeral') !== 'beta').map((u) => {
      const rec = users[u];
      const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ');
      return { account: u, email: rec.email || null, name: name || null,
        lastLogin: rec.lastLogin || null, usedBytes: rec.bytes || 0, usedMb: +(((rec.bytes || 0) / 1048576).toFixed(2)) };
    });
    // Full roster of every account (includes beta owner accounts that hold no PIN).
    const pinByAccount = {}; Object.keys(pins.codes).forEach((c) => { if (pins.codes[c].account) pinByAccount[pins.codes[c].account] = c; });
    const accounts = Object.keys(users).sort().map((u) => {
      const rec = users[u];
      const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ');
      const isBeta = (rec.tier || 'ephemeral') === 'beta';
      return { account: u, tier: rec.tier || 'ephemeral', pin: pinByAccount[u] || null,
        limitMb: isBeta ? userLimitMb(rec) : 0,
        email: rec.email || null, name: name || null, lastLogin: rec.lastLogin || null,
        usedBytes: rec.bytes || 0, usedMb: +(((rec.bytes || 0) / 1048576).toFixed(2)) };
    });
    // Planned storage = PIN slots (each at the default cap) + any beta accounts
    // that don't hold a PIN (insiders), each at their own cap.
    const pinPlannedMb = rows.length * MAX_USER_MB;
    const insiderPlannedMb = accounts.filter((a) => a.tier === 'beta' && !a.pin).reduce((s, a) => s + a.limitMb, 0);
    sendJSON(res, 200, { ok: true, limitMb: MAX_USER_MB,
      pinsTotal: rows.length, pinsUsed: rows.filter((r) => r.account).length,
      accountsTotal: accounts.length, betaAccounts: accounts.filter((a) => a.tier === 'beta').length,
      plannedStorageMb: pinPlannedMb + insiderPlannedMb,
      plannedStorageBreakdown: { pinSlotsMb: pinPlannedMb, insiderAccountsMb: insiderPlannedMb },
      accounts, pins: rows, ephemeralAccounts: ephemeral });
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
      sendJSONZ(req, res, 200, data); // gzip: the graph can be tens of MB
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
      // ── Tiered storage enforcement (public mode) ──────────────────────────
      if (PUBLIC_MODE) {
        const db = loadAuthDb();
        const rec = db.users[base];
        const bytes = Buffer.byteLength(jsonStr, 'utf8');
        const now = new Date().toISOString();
        // Ephemeral accounts never persist server-side — their data stays in the
        // browser. We record usage and tell the client to keep it local.
        if (!rec || rec.tier !== 'beta') {
          if (rec) { rec.bytes = bytes; rec.lastLogin = now; saveAuthDb(); }
          return sendJSON(res, 200, { ok: false, ephemeral: true,
            error: 'Your work is saved in this browser only. Enter an invite PIN to enable cloud backup.' });
        }
        // Beta accounts: hard cap (per-account override or global). Over → red alert.
        const capMb = userLimitMb(rec);
        if (bytes > capMb * 1048576) {
          rec.lastLogin = now; saveAuthDb();
          return sendJSON(res, 413, { ok: false, overLimit: true,
            limitMb: capMb, usedMb: +(bytes / 1048576).toFixed(2),
            error: `Storage limit reached (${capMb} MB). Upgrade to keep saving to the cloud — new changes are held in this browser for now.` });
        }
        // Anti-clobber: never let a fresh starter graph wipe out substantial saved
        // data (guards against a stale/buggy client re-creating a new-account shell).
        try {
          const exFp = path.join(DATA_DIR, `${base}_data.json`);
          if (fs.existsSync(exFp)) {
            const cur = JSON.parse(fs.readFileSync(exFp, 'utf8'));
            const curN = Array.isArray(cur.nodes) ? cur.nodes.length : 0;
            const inN = Array.isArray(data.nodes) ? data.nodes.length : 0;
            if (curN >= 10 && inN <= 5 && inN < curN) {
              console.warn(`🛡️  Blocked clobber of ${base}: stored ${curN} nodes vs incoming ${inN}`);
              return sendJSON(res, 409, { ok: false, clobberBlocked: true, storedNodes: curN, incomingNodes: inN,
                error: 'Save blocked to protect your data: the cloud copy is much larger than what was sent (looks like an accidental reset). Reload the page to pull your cloud data.' });
            }
          }
        } catch (_) { /* if unsure, allow the write */ }
        rec.bytes = bytes; rec.lastLogin = now; saveAuthDb();
      }
      const canonicalFp = path.join(DATA_DIR, `${base}_data.json`);
      let toWrite = jsonStr;
      if (PUBLIC_MODE) {
        const ex = externalizeInlineImages(base, jsonStr);
        toWrite = ex.slim;
        if (ex.count) console.log(`🖼️  ${base}: externalized ${ex.count} image(s) (+${(ex.bytes / 1048576).toFixed(2)} MB media) → JSON now ${(Buffer.byteLength(toWrite, 'utf8') / 1048576).toFixed(2)} MB`);
      }
      atomicWriteFileSync(canonicalFp, toWrite);
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
      sendJSONZ(req, res, 200, data); // gzip: agent archive can be several MB
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

  // ── GET /api/media/<user>/<hash>.<ext> ──
  // Content-addressed image extracted from a user's notes (see externalizeInlineImages).
  // The URL is a capability (64-hex content hash → unguessable), so it needs no session
  // — an <img> tag can't send an auth header. Immutable + long cache: fetched once.
  {
    const mm = p.match(/^\/api\/media\/([^/]+)\/([a-f0-9]{16,64})\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i);
    if (mm && req.method === 'GET') {
      const mBase = storageBaseKey(sanitize(mm[1]));
      const fname = `${mm[2].toLowerCase()}.${mm[3].toLowerCase()}`;
      const abs = path.join(DATA_DIR, mBase, 'media', fname);
      if (!abs.startsWith(DATA_DIR)) { res.writeHead(404); res.end('Not Found'); return; }
      // Ephemeral Render disk: the blob may live in the repo but not yet on disk
      // (boot hydration still running / restarted). Pull just this one on demand.
      if (!fs.existsSync(abs)) {
        const got = await ghHydrateOne(`${mBase}/media/${fname}`);
        if (!got || !fs.existsSync(abs)) {
          // Genuinely not here yet — tell the client to retry shortly (not a hard 404).
          res.writeHead(GH_ENABLED ? 503 : 404, GH_ENABLED ? { 'Retry-After': '2', 'Cache-Control': 'no-store' } : {});
          res.end(GH_ENABLED ? 'Hydrating' : 'Not Found');
          return;
        }
      }
      const etag = '"' + mm[2].toLowerCase() + '"';
      const cacheHdr = 'public, max-age=31536000, immutable';
      // Harden: user-supplied bytes served from our origin. nosniff stops MIME
      // confusion; the CSP/sandbox neutralizes scripts inside an SVG opened directly.
      const secHdr = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': cacheHdr }, secHdr)); res.end(); return; }
      const mtype = MIME['.' + mm[3].toLowerCase()]
        || { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[mm[3].toLowerCase()]
        || 'application/octet-stream';
      try {
        const content = fs.readFileSync(abs);
        res.writeHead(200, Object.assign({ 'Content-Type': mtype, 'Cache-Control': cacheHdr, 'ETag': etag, 'Content-Length': content.length }, secHdr));
        res.end(content);
      } catch (_) { res.writeHead(404); res.end('Not Found'); }
      return;
    }
  }

  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.join(REPO_ROOT, filePath);
  if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const stat = fs.statSync(filePath);
    const headers = { 'Content-Type': mime };
    // App code (html/js/css) must never be served stale — a stale app.js was able
    // to overwrite cloud data. no-cache forces revalidation; the ETag lets an
    // unchanged file still answer 304 (cheap) but a redeploy (new mtime) busts it.
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      const etag = 'W/"' + stat.size + '-' + Math.floor(stat.mtimeMs) + '"';
      headers['Cache-Control'] = 'no-cache';
      headers['ETag'] = etag;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    }
    const content = fs.readFileSync(filePath);
    // gzip text assets (app.js is ~1.5 MB) — big win on first paint over the network.
    if (ext === '.js' || ext === '.css' || ext === '.html' || ext === '.svg' || ext === '.json') {
      endMaybeGzip(req, res, 200, headers, content);
    } else {
      res.writeHead(200, headers);
      res.end(content);
    }
  } catch { res.writeHead(404); res.end('Not Found'); }
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
  if (PUBLIC_MODE) { try { ensurePins(); } catch (e) { console.warn('ensurePins:', e.message); } }
  server.listen(PORT, '0.0.0.0', () => {
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
