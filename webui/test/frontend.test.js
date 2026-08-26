const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('dashboard uses local assets and safe DOM rendering', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(html, /<dialog/);
  assert.match(html, /prefers-reduced-motion|style\.css/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'node_modules', 'qrcodejs', 'qrcode.min.js')));

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = [...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referencedIds.filter((id) => !htmlIds.has(id)))], []);
});
