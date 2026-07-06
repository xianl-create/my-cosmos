#!/usr/bin/env node
/**
 * Cost guard for the My Cosmos Render deployment.
 *
 * Purpose: make sure the hosted demo never quietly costs more than the approved
 * budget (default $7/month = one Starter web service, 1 instance, within the
 * workspace's included bandwidth). If projected spend would exceed the cap, the
 * guard writes a MAJOR-ALERT HTML report naming the specific reason(s) and, in
 * --enforce mode, SUSPENDS the billable service(s) so no extra charge accrues.
 * Resuming (i.e. granting permission to spend more) is a deliberate manual step.
 *
 * Usage:
 *   node scripts/cost-guard.js            # check + write report (no changes)
 *   node scripts/cost-guard.js --enforce  # + suspend services if over budget
 *   node scripts/cost-guard.js --resume   # resume suspended services (grant permission)
 *
 * Config (env, all optional):
 *   RENDER_API_KEY     Render API key (falls back to DEPLOY-KEYS.txt locally)
 *   RENDER_OWNER_ID    workspace id (default: the My Cosmos workspace)
 *   COST_GUARD_MAX_USD approved monthly cap (default 7)
 *   COST_GUARD_BW_GB   included outbound bandwidth in GB (default 5, Hobby plan)
 *   COST_GUARD_HTML    output path for the report (default ../cost-alert.html)
 *
 * Exit code: 0 = within budget, 2 = OVER BUDGET (so CI fails and emails you), 1 = error.
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const CAP_USD = parseFloat(process.env.COST_GUARD_MAX_USD || '7');
const BW_INCLUDED_GB = parseFloat(process.env.COST_GUARD_BW_GB || '5');
const BW_OVERAGE_PER_GB = 0.15; // Render outbound overage rate
const OWNER_ID = process.env.RENDER_OWNER_ID || 'tea-d958qopoagis738kgji0';
const OUT_HTML = process.env.COST_GUARD_HTML || path.join(__dirname, '..', 'cost-alert.html');
const ENFORCE = process.argv.includes('--enforce');
const RESUME = process.argv.includes('--resume');

// Render compute plan pricing (USD/month, per instance).
const PLAN_USD = { free: 0, starter: 7, standard: 25, pro: 85, pro_plus: 175, pro_max: 225, pro_ultra: 450 };

function resolveKey() {
  if (process.env.RENDER_API_KEY && process.env.RENDER_API_KEY.trim()) return process.env.RENDER_API_KEY.trim();
  try {
    const t = fs.readFileSync(path.join(__dirname, '..', 'DEPLOY-KEYS.txt'), 'utf8');
    const m = t.match(/^RENDER_API_KEY=\s*(\S+)/m);
    if (m) return m[1].trim();
  } catch (_) { /* no local file — env only */ }
  return '';
}
const API_KEY = resolveKey();
if (!API_KEY) { console.error('cost-guard: no RENDER_API_KEY (set env or DEPLOY-KEYS.txt).'); process.exit(1); }

function api(method, p) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, hostname: 'api.render.com', path: '/v1' + p,
      headers: { Authorization: 'Bearer ' + API_KEY, Accept: 'application/json' } }, (resp) => {
      let s = ''; resp.on('data', (d) => { s += d; });
      resp.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => { try { r.destroy(new Error('render api timeout')); } catch (_) {} });
    r.end();
  });
}

async function listServices() {
  const r = await api('GET', '/services?limit=100&ownerId=' + encodeURIComponent(OWNER_ID));
  const arr = Array.isArray(r.body) ? r.body : [];
  return arr.map((x) => x.service || x);
}
async function serviceDetail(id) { const r = await api('GET', '/services/' + id); return r.body; }
function isSuspended(d) { return d && (d.suspended === 'suspended' || d.suspended === true); }

async function bandwidthGBThisMonth(ids) {
  if (!ids.length) return 0;
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const q = ids.map((id) => 'resource=' + encodeURIComponent(id)).join('&');
  const r = await api('GET', `/metrics/bandwidth?${q}&startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(new Date().toISOString())}`);
  let mb = 0;
  if (Array.isArray(r.body)) for (const series of r.body) for (const v of (series.values || [])) mb += (v.value || 0);
  return mb / 1024;
}

function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function writeReport({ breach, projected, compute, bwGB, bwOver, reasons, rows, actions }) {
  const when = new Date().toISOString();
  const banner = breach
    ? `<div style="background:#7f1d1d;color:#fff;padding:18px 22px;border-radius:10px;font-size:20px;font-weight:800">🚨 MAJOR ALERT — projected spend $${projected.toFixed(2)}/mo exceeds the $${CAP_USD.toFixed(2)} cap</div>`
    : `<div style="background:#065f46;color:#fff;padding:18px 22px;border-radius:10px;font-size:20px;font-weight:800">✅ Within budget — projected spend $${projected.toFixed(2)}/mo (cap $${CAP_USD.toFixed(2)})</div>`;
  const reasonList = reasons.length
    ? '<ul style="line-height:1.6">' + reasons.map((r) => `<li><b>${esc(r)}</b></li>`).join('') + '</ul>'
    : '<p style="color:#065f46">No cost drivers above the approved baseline.</p>';
  const actionList = (actions && actions.length)
    ? '<h3>Actions taken</h3><ul style="line-height:1.6">' + actions.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>'
    : '';
  const tableRows = rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(r.plan)}</td><td style="text-align:right">${r.instances}</td><td>${r.suspended ? 'suspended' : 'running'}</td><td style="text-align:right">$${r.cost.toFixed(2)}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Cosmos — Cost Guard</title></head>
<body style="margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:820px;margin:0 auto;padding:28px">
    <h1 style="font-size:22px">My Cosmos — Cost Guard</h1>
    <p style="color:#94a3b8;margin-top:-6px">Checked ${esc(when)} · workspace <code>${esc(OWNER_ID)}</code> · cap <b>$${CAP_USD.toFixed(2)}/mo</b></p>
    ${banner}
    <h3>Why</h3>
    ${reasonList}
    ${actionList}
    <h3>Cost breakdown</h3>
    <table style="width:100%;border-collapse:collapse" cellpadding="8">
      <thead><tr style="text-align:left;border-bottom:1px solid #334155"><th>Service</th><th>Type</th><th>Plan</th><th style="text-align:right">Inst.</th><th>State</th><th style="text-align:right">$/mo</th></tr></thead>
      <tbody style="border-bottom:1px solid #1f2937">${tableRows}</tbody>
    </table>
    <p style="margin-top:14px">Compute: <b>$${compute.toFixed(2)}/mo</b> · Bandwidth this month: <b>${bwGB.toFixed(2)} GB</b> of ${BW_INCLUDED_GB} GB included (overage <b>$${bwOver.toFixed(2)}</b>) · <b>Projected total: $${projected.toFixed(2)}/mo</b></p>
    <h3>Granting permission to spend more</h3>
    <p style="color:#cbd5e1;line-height:1.6">This guard treats <b>$${CAP_USD.toFixed(2)}/mo</b> as the approved ceiling. To approve a higher budget, raise <code>COST_GUARD_MAX_USD</code> (env / workflow). To bring a suspended service back online after reviewing the reason above, run <code>node scripts/cost-guard.js --resume</code> (or resume it in the Render dashboard).</p>
  </div>
</body></html>`;
  fs.writeFileSync(OUT_HTML, html);
}

(async () => {
  const services = await listServices();
  const details = [];
  for (const s of services) { const d = await serviceDetail(s.id); if (d) details.push(d); }

  if (RESUME) {
    let n = 0;
    for (const d of details) {
      if (isSuspended(d)) { const r = await api('POST', '/services/' + d.id + '/resume'); if (r.status >= 200 && r.status < 300) { n++; console.log('resumed', d.name); } }
    }
    console.log(`cost-guard: resumed ${n} service(s).`);
    return;
  }

  const reasons = [];
  const rows = [];
  let compute = 0;
  for (const d of details) {
    const sd = d.serviceDetails || {};
    const plan = String(sd.plan || '').toLowerCase();
    const inst = sd.numInstances || 1;
    const suspended = isSuspended(d);
    const base = PLAN_USD[plan] != null ? PLAN_USD[plan] : 0;
    const cost = suspended ? 0 : base * inst;
    compute += cost;
    rows.push({ name: d.name || d.id, type: d.type || '?', plan: plan || 'n/a', instances: inst, suspended, cost });
    if (!suspended && base > PLAN_USD.starter) reasons.push(`Service "${d.name}" is on the ${plan} plan ($${base}/mo) — above the Starter $${PLAN_USD.starter} baseline.`);
    if (!suspended && inst > 1) reasons.push(`Service "${d.name}" is running ${inst} instances ($${base}×${inst} = $${base * inst}/mo).`);
    if (PLAN_USD[plan] == null && plan) reasons.push(`Service "${d.name}" is on an unrecognized plan "${plan}" — review its cost manually.`);
  }
  const billableActive = rows.filter((r) => !r.suspended && r.cost > 0);
  if (billableActive.length > 1) reasons.push(`${billableActive.length} paid services are active at once — only one Starter service is approved.`);

  const bwGB = await bandwidthGBThisMonth(details.map((d) => d.id));
  const bwOver = Math.max(0, bwGB - BW_INCLUDED_GB) * BW_OVERAGE_PER_GB;
  if (bwOver > 0) reasons.push(`Outbound bandwidth this month is ${bwGB.toFixed(2)} GB, over the ${BW_INCLUDED_GB} GB included — overage ≈ $${bwOver.toFixed(2)} and climbing.`);

  const projected = compute + bwOver;
  const breach = projected > CAP_USD + 1e-9 || reasons.length > 0;

  const actions = [];
  if (breach && ENFORCE) {
    for (const d of details) {
      const sd = d.serviceDetails || {};
      const base = PLAN_USD[String(sd.plan || '').toLowerCase()] || 0;
      if (!isSuspended(d) && base > 0) {
        const r = await api('POST', '/services/' + d.id + '/suspend');
        actions.push(r.status >= 200 && r.status < 300
          ? `Suspended "${d.name}" to stop further charges (resume manually to approve continued spend).`
          : `Tried to suspend "${d.name}" but Render returned HTTP ${r.status}.`);
      }
    }
  } else if (breach) {
    actions.push('Detect-only run: nothing was suspended. Re-run with --enforce (the scheduled job does) to auto-stop charges.');
  }

  writeReport({ breach, projected, compute, bwGB, bwOver, reasons, rows, actions });

  console.log(`cost-guard: projected $${projected.toFixed(2)}/mo (cap $${CAP_USD.toFixed(2)}) — ${breach ? 'OVER BUDGET' : 'ok'}`);
  reasons.forEach((r) => console.log(' - ' + r));
  actions.forEach((a) => console.log(' * ' + a));
  console.log('report: ' + OUT_HTML);
  process.exit(breach ? 2 : 0);
})().catch((e) => { console.error('cost-guard error:', e && e.message || e); process.exit(1); });
