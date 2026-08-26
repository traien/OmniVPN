const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const securityPath = path.join(__dirname, '..', 'security.js');

test('security module refuses weak administrator credentials', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(securityPath)})`], {
    env: { ...process.env, WEBUI_PASSWORD: 'short' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 16 characters/);
});

test('password comparison accepts only the configured value', () => {
  const script = `const s=require(${JSON.stringify(securityPath)}); process.exit(s.passwordMatches('correct-password-123') && !s.passwordMatches('wrong-password-123') ? 0 : 1)`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WEBUI_PASSWORD: 'correct-password-123' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('each login receives an independent authenticated session', () => {
  const script = `
    const s = require(${JSON.stringify(securityPath)});
    const issue = () => {
      let token;
      s.setSessionCookie({ cookies: {} }, { cookie: (_name, value) => { token = value; } });
      return token;
    };
    const first = issue();
    const second = issue();
    if (!first || first === second) process.exit(1);
    if (!s.isAuthenticated({ cookies: { omnivpn_session: first } })) process.exit(2);
    if (!s.isAuthenticated({ cookies: { omnivpn_session: second } })) process.exit(3);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WEBUI_PASSWORD: 'correct-password-123' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
