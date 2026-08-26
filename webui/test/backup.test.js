const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptedArchive, decryptArchive, validateAndExtract } = require('../backup');

test('backup encryption round-trips and rejects tampering', async (t) => {
  process.env.BACKUP_PASSPHRASE = 'test-only-passphrase-with-32-characters';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnivpn-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const extract = path.join(root, 'extract');
  const encrypted = path.join(root, 'backup.ovpnbackup');
  const archive = path.join(root, 'backup.tar.gz');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ version: 2, exportedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(source, 'data', 'users.json'), '{"users":{}}');

  await createEncryptedArchive(source, encrypted);
  await decryptArchive(encrypted, archive);
  await validateAndExtract(archive, extract);
  assert.equal(fs.readFileSync(path.join(extract, 'data', 'users.json'), 'utf8'), '{"users":{}}');

  const buffer = fs.readFileSync(encrypted);
  buffer[Math.floor(buffer.length / 2)] ^= 0xff;
  fs.writeFileSync(encrypted, buffer);
  await assert.rejects(() => decryptArchive(encrypted, path.join(root, 'tampered.tar.gz')), /authentication failed/i);
});
