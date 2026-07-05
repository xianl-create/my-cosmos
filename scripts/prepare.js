#!/usr/bin/env node
/**
 * Prepares double-click (file://) loading: Chrome blocks fetch() to ./data/*.json, but <script src> works.
 * Writes data/file_boot.js + data/users_index.json so index.html can bootstrap user data.
 * Run: node scripts/prepare.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_BOOT = path.join(DATA_DIR, 'file_boot.js');
const USERS_INDEX = path.join(DATA_DIR, 'users_index.json');

function isReservedTemplateUserDataFile(filename) {
  return /^template-user_data\.json$/i.test(filename || '');
}

const STUB_BOOT = `/* Run: node scripts/prepare.js after adding data/*_data.json — needed for file:// in Chrome. */\n`;

function atomicWriteFileSync(destPath, content) {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    if (process.platform === 'win32' && fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
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

try {
  const files = fs.readdirSync(DATA_DIR).filter(f =>
    f.endsWith('_data.json') && !f.includes('_sp_') && !isReservedTemplateUserDataFile(f)
  );
  atomicWriteFileSync(USERS_INDEX, JSON.stringify({ files }, null, 2));
  if (files.length === 0) {
    atomicWriteFileSync(FILE_BOOT, STUB_BOOT);
    console.log('No *_data.json in data/ — wrote empty users_index.json and stub file_boot.js');
    process.exit(0);
  }
  const f = files[0];
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
  const fullUsername = path.basename(f, '.json');
  const username = fullUsername.replace(/_data$/, '') || fullUsername;
  const payload = { username, data };
  const bootJs = 'window.__PRELOAD_USER_DATA__=' + JSON.stringify(payload) + ';';
  atomicWriteFileSync(FILE_BOOT, bootJs);
  console.log('Wrote', path.relative(process.cwd(), FILE_BOOT), 'from', f, `(${files.length} user file(s) in users_index.json)`);
} catch (e) {
  console.error('prepare.js error:', e.message);
  process.exit(1);
}
