#!/usr/bin/env node
/**
 * Keep the cloud copy of ONE account's data in sync (home/calendar/notes + agents).
 *
 * Reads the local canonical data file (data/<user>_data.json) and pushes it to
 * the hosted My Cosmos server whenever it changes. The server persists it to
 * disk AND commits it to the private GitHub data repo, so the online URL and the
 * repo track your local edits within seconds.
 *
 * It ALSO mirrors this account's agent archive (data/<user>/agents/): the live
 * manifest.json + each agent's detail.json are assembled into the same payload
 * the app uses and POSTed to /api/agents-data/<user>, which the cloud stores and
 * commits to the private repo. Local agent autobackups (data/<user>/agents_autobackup_*)
 * are NOT uploaded. Set MC_SYNC_AGENTS=0 to skip agents and mirror only the graph.
 *
 * This is a one-way mirror: local -> cloud. Treat the online account as
 * view/login only; editing it online too would be overwritten on the next
 * local save.
 *
 * Auth: prefer MC_SYNC_TOKEN (the server's sync/admin token). It writes straight
 * through WITHOUT a login, so mirroring never rotates the session and never kicks
 * the owner's online browser (single-device sessions). Falls back to MC_PASS login
 * if no sync token is given.
 *
 * Config (environment variables):
 *   MC_CLOUD_URL    hosted base URL           (default https://my-cosmos.onrender.com)
 *   MC_USER         account username          (default xianl)
 *   MC_SYNC_TOKEN   server sync/admin token   (preferred — no login, no session kick)
 *   MC_PASS         account password          (fallback if no MC_SYNC_TOKEN)
 *   MC_FILE         local data file           (default data/<MC_USER>_data.json)
 *   MC_AGENTS_DIR   local agents archive dir  (default data/<MC_USER>/agents)
 *   MC_SYNC_AGENTS  "1" mirror agents too     (default "1"); "0" = graph only
 *   MC_WATCH        "1" watch+push on change  (default "1"); "0" = one-shot upload then exit
 *   MC_INTERVAL     watch poll ms             (default 2000)
 *
 * Usage:
 *   MC_PASS='your-cloud-password' node scripts/sync-to-cloud.js          # push now + keep syncing
 *   MC_PASS='your-cloud-password' MC_WATCH=0 node scripts/sync-to-cloud.js   # one-shot upload
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CLOUD_URL = (process.env.MC_CLOUD_URL || 'https://my-cosmos.onrender.com').replace(/\/+$/, '');
const USER = (process.env.MC_USER || 'xianl').toLowerCase().replace(/[^a-z0-9_-]/g, '');
const SYNC_TOKEN = process.env.MC_SYNC_TOKEN || '';
const PASS = process.env.MC_PASS || '';
const FILE = process.env.MC_FILE || path.join(__dirname, '..', 'data', `${USER}_data.json`);
const AGENTS_DIR = process.env.MC_AGENTS_DIR || path.join(__dirname, '..', 'data', USER, 'agents');
const SYNC_AGENTS = (process.env.MC_SYNC_AGENTS || '1') !== '0';
const WATCH = (process.env.MC_WATCH || '1') !== '0';
const INTERVAL = parseInt(process.env.MC_INTERVAL, 10) || 2000;
const DEBOUNCE_MS = 1500;

if (!SYNC_TOKEN && !PASS) { console.error('sync-to-cloud: set MC_SYNC_TOKEN (preferred) or MC_PASS.'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.error('sync-to-cloud: local data file not found:', FILE); process.exit(1); }

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function req(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(CLOUD_URL + urlPath);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body != null ? Buffer.from(body, 'utf8') : null;
    const headers = { Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (SYNC_TOKEN) headers['X-Sync-Token'] = SYNC_TOKEN;
    else if (token) headers['X-Auth-Token'] = token;
    const r = lib.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (resp) => {
      let s = ''; resp.setEncoding('utf8'); resp.on('data', (d) => { s += d; });
      resp.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: s }); });
    });
    r.on('error', reject);
    r.setTimeout(120000, () => { try { r.destroy(new Error('timeout')); } catch (_) {} });
    if (payload) r.write(payload);
    r.end();
  });
}

let token = '';
async function login() {
  const r = await req('POST', '/api/auth/login', { body: JSON.stringify({ username: USER, password: PASS }) });
  if (r.status === 200 && r.body && r.body.ok && r.body.token) {
    token = r.body.token;
    const tier = r.body.tier || 'unknown';
    console.log(`[${ts()}] signed in as ${USER} (tier: ${tier})`);
    if (tier !== 'beta') console.warn(`[${ts()}] ⚠ account is "${tier}", not "beta" — the cloud will NOT persist data until it's a beta account. Ask to enable cloud storage for ${USER}.`);
    return true;
  }
  if (r.body && r.body.needVerify) { console.error(`[${ts()}] ✗ account needs email verification before it can sign in.`); return false; }
  console.error(`[${ts()}] ✗ sign-in failed: ${(r.body && r.body.error) || r.status}`);
  return false;
}

let pushing = false;
let pendingAgain = false;
async function pushOnce() {
  if (pushing) { pendingAgain = true; return; }
  pushing = true;
  try {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); JSON.parse(raw); } // validate JSON before uploading
    catch (e) { console.warn(`[${ts()}] skip: local file not valid JSON yet (${e.message})`); return; }
    const mb = (Buffer.byteLength(raw, 'utf8') / 1048576).toFixed(2);
    if (!SYNC_TOKEN && !token && !(await login())) return;
    let r = await req('POST', `/api/data/${encodeURIComponent(USER)}`, { token, body: raw });
    if (r.status === 401 && SYNC_TOKEN) { console.error(`[${ts()}] ✗ sync token rejected — check MC_SYNC_TOKEN matches the server's admin/sync token.`); return; }
    if (r.status === 401) { token = ''; if (!(await login())) return; r = await req('POST', `/api/data/${encodeURIComponent(USER)}`, { token, body: raw }); }
    if (r.status === 200 && r.body && r.body.ok) { console.log(`[${ts()}] ✓ synced ${mb} MB to ${CLOUD_URL}`); return; }
    if (r.status === 413 && r.body && r.body.overLimit) { console.error(`[${ts()}] 🚨 STORAGE LIMIT: used ${r.body.usedMb} MB of ${r.body.limitMb} MB — cloud rejected this save. Free up space or raise the cap.`); return; }
    if (r.body && r.body.ephemeral) { console.error(`[${ts()}] ⚠ cloud says this account is browser-only (ephemeral) — data not stored. Enable beta/cloud storage for ${USER}.`); return; }
    console.error(`[${ts()}] ✗ sync failed: HTTP ${r.status} ${(r.body && r.body.error) || ''}`);
  } finally {
    pushing = false;
    if (pendingAgain) { pendingAgain = false; setTimeout(pushOnce, 250); }
  }
}

// ── Agents archive mirror (data/<user>/agents → /api/agents-data/<user>) ──
const AGENTS_MANIFEST = path.join(AGENTS_DIR, 'manifest.json');
const SLUG_RE = /^[a-z0-9_-]{1,48}$/i;

// Assemble the same {version, summary, graph, agents} payload the app/server use,
// reading files directly so we don't depend on the local server being up.
function readLocalAgentsArchive() {
  if (!fs.existsSync(AGENTS_MANIFEST)) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(AGENTS_MANIFEST, 'utf8')); }
  catch (e) { throw new Error(`agents manifest not valid JSON yet (${e.message})`); }
  const agents = {};
  const seen = new Set();
  (manifest.agentSlugs || []).forEach((slug) => {
    if (!SLUG_RE.test(String(slug))) return;
    const fp = path.join(AGENTS_DIR, slug, 'detail.json');
    if (fs.existsSync(fp)) { try { agents[slug] = JSON.parse(fs.readFileSync(fp, 'utf8')); seen.add(slug); } catch (_) {} }
  });
  try {
    fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).forEach((de) => {
      if (!de.isDirectory() || seen.has(de.name) || !SLUG_RE.test(de.name)) return;
      const fp = path.join(AGENTS_DIR, de.name, 'detail.json');
      if (fs.existsSync(fp)) { try { agents[de.name] = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) {} }
    });
  } catch (_) {}
  return {
    version: manifest.version || 1,
    summary: Array.isArray(manifest.summary) ? manifest.summary : [],
    graph: (manifest.graph && typeof manifest.graph === 'object') ? manifest.graph : { nodes: [], edges: [] },
    agents,
  };
}

let pushingA = false;
let pendingAgainA = false;
async function pushAgentsOnce() {
  if (!SYNC_AGENTS) return;
  if (pushingA) { pendingAgainA = true; return; }
  pushingA = true;
  try {
    let archive;
    try { archive = readLocalAgentsArchive(); }
    catch (e) { console.warn(`[${ts()}] skip agents: ${e.message}`); return; }
    if (!archive) return; // no agents archive on disk yet
    const nAgents = Object.keys(archive.agents).length;
    if (nAgents === 0) { console.log(`[${ts()}] agents: nothing to sync (0 agents)`); return; }
    const raw = JSON.stringify(archive);
    const mb = (Buffer.byteLength(raw, 'utf8') / 1048576).toFixed(2);
    if (!SYNC_TOKEN && !token && !(await login())) return;
    let r = await req('POST', `/api/agents-data/${encodeURIComponent(USER)}`, { token, body: raw });
    if (r.status === 401 && SYNC_TOKEN) { console.error(`[${ts()}] ✗ agents sync token rejected — check MC_SYNC_TOKEN.`); return; }
    if (r.status === 401) { token = ''; if (!(await login())) return; r = await req('POST', `/api/agents-data/${encodeURIComponent(USER)}`, { token, body: raw }); }
    if (r.status === 200 && r.body && r.body.ok) {
      if (r.body.skipped) console.warn(`[${ts()}] ⚠ agents skipped by cloud: ${r.body.skipped}`);
      else console.log(`[${ts()}] ✓ synced ${nAgents} agents (${mb} MB) to ${CLOUD_URL}`);
      return;
    }
    if (r.body && r.body.ephemeral) { console.error(`[${ts()}] ⚠ cloud says this account is browser-only (ephemeral) — agents not stored.`); return; }
    console.error(`[${ts()}] ✗ agents sync failed: HTTP ${r.status} ${(r.body && r.body.error) || ''}`);
  } finally {
    pushingA = false;
    if (pendingAgainA) { pendingAgainA = false; setTimeout(pushAgentsOnce, 250); }
  }
}

(async () => {
  console.log(`sync-to-cloud → ${CLOUD_URL}  account=${USER}  auth=${SYNC_TOKEN ? 'sync-token (no login)' : 'password login'}  file=${path.relative(process.cwd(), FILE)}`);
  if (SYNC_AGENTS) console.log(`  agents mirror: ${fs.existsSync(AGENTS_DIR) ? path.relative(process.cwd(), AGENTS_DIR) : '(none yet)'}`);
  await pushOnce();       // initial graph upload
  await pushAgentsOnce(); // initial agents upload
  if (!WATCH) return;
  console.log(`[${ts()}] watching for local changes (Ctrl+C to stop)…`);
  let timer = null;
  fs.watchFile(FILE, { interval: INTERVAL }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(timer);
    timer = setTimeout(pushOnce, DEBOUNCE_MS);
  });
  if (SYNC_AGENTS) {
    let timerA = null;
    // Agent edits rewrite manifest.json; watch it as the change signal for the archive.
    fs.watchFile(AGENTS_MANIFEST, { interval: INTERVAL }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return;
      clearTimeout(timerA);
      timerA = setTimeout(pushAgentsOnce, DEBOUNCE_MS);
    });
  }
})().catch((e) => { console.error('sync-to-cloud error:', e && e.message || e); process.exit(1); });
