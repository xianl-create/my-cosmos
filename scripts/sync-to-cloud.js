#!/usr/bin/env node
/**
 * Keep the cloud copy of ONE account's home/calendar/notes in sync.
 *
 * Reads the local canonical data file (data/<user>_data.json) and pushes it to
 * the hosted My Cosmos server whenever it changes. The server persists it to
 * disk AND commits it to the private GitHub data repo, so the online URL and the
 * repo track your local edits within seconds. Agent data (the separate
 * data/<user>/ folder) is never read or uploaded.
 *
 * This is a one-way mirror: local -> cloud. Treat the online account as
 * view/login only; editing it online too would be overwritten on the next
 * local save.
 *
 * Config (environment variables):
 *   MC_CLOUD_URL  hosted base URL           (default https://my-cosmos.onrender.com)
 *   MC_USER       account username          (default xianl)
 *   MC_PASS       account password          (REQUIRED — pass via env, never hard-code)
 *   MC_FILE       local data file           (default data/<MC_USER>_data.json)
 *   MC_WATCH      "1" watch+push on change  (default "1"); "0" = one-shot upload then exit
 *   MC_INTERVAL   watch poll ms             (default 2000)
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
const PASS = process.env.MC_PASS || '';
const FILE = process.env.MC_FILE || path.join(__dirname, '..', 'data', `${USER}_data.json`);
const WATCH = (process.env.MC_WATCH || '1') !== '0';
const INTERVAL = parseInt(process.env.MC_INTERVAL, 10) || 2000;
const DEBOUNCE_MS = 1500;

if (!PASS) { console.error('sync-to-cloud: set MC_PASS to your cloud account password.'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.error('sync-to-cloud: local data file not found:', FILE); process.exit(1); }

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function req(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(CLOUD_URL + urlPath);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body != null ? Buffer.from(body, 'utf8') : null;
    const headers = { Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['X-Auth-Token'] = token;
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
    if (!token && !(await login())) return;
    let r = await req('POST', `/api/data/${encodeURIComponent(USER)}`, { token, body: raw });
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

(async () => {
  console.log(`sync-to-cloud → ${CLOUD_URL}  account=${USER}  file=${path.relative(process.cwd(), FILE)}`);
  await pushOnce(); // initial upload
  if (!WATCH) return;
  console.log(`[${ts()}] watching for local changes (Ctrl+C to stop)…`);
  let timer = null;
  fs.watchFile(FILE, { interval: INTERVAL }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(timer);
    timer = setTimeout(pushOnce, DEBOUNCE_MS);
  });
})().catch((e) => { console.error('sync-to-cloud error:', e && e.message || e); process.exit(1); });
