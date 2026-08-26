const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { TarArchive } = require('archiver');
const tar = require('tar');

const MAGIC = Buffer.from('OMNIVPN1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const ALLOWED_ROOTS = new Set(['ipsec.d', 'ppp', 'wireguard', 'xray', 'data']);
const ALLOWED_FILES = new Set(['manifest.json', 'vpn.env']);

function getPassphrase() {
  const value = process.env.BACKUP_PASSPHRASE;
  if (!value || value.length < 20) {
    throw new Error('BACKUP_PASSPHRASE must be configured with at least 20 characters.');
  }
  return value;
}

function createTar(sourceDir, tarPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tarPath, { mode: 0o600 });
    const archive = new TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

class EncryptTransform extends Transform {
  constructor(cipher, header) {
    super();
    this.cipher = cipher;
    this.header = header;
    this.sentHeader = false;
  }

  _transform(chunk, encoding, callback) {
    if (!this.sentHeader) {
      this.push(this.header);
      this.sentHeader = true;
    }
    this.push(this.cipher.update(chunk));
    callback();
  }

  _flush(callback) {
    if (!this.sentHeader) this.push(this.header);
    this.push(this.cipher.final());
    this.push(this.cipher.getAuthTag());
    callback();
  }
}

async function createEncryptedArchive(sourceDir, encryptedPath) {
  const passphrase = getPassphrase();
  const tarPath = `${encryptedPath}.tar.gz`;
  await createTar(sourceDir, tarPath);
  try {
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const header = Buffer.concat([MAGIC, salt, iv]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    await pipeline(
      fs.createReadStream(tarPath),
      new EncryptTransform(cipher, header),
      fs.createWriteStream(encryptedPath, { mode: 0o600 })
    );
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}

async function decryptArchive(encryptedPath, tarPath) {
  const passphrase = getPassphrase();
  const stat = fs.statSync(encryptedPath);
  if (stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error('Backup file is truncated.');

  const descriptor = fs.openSync(encryptedPath, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    fs.readSync(descriptor, header, 0, HEADER_BYTES, 0);
    fs.readSync(descriptor, tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    fs.closeSync(descriptor);
  }

  if (!crypto.timingSafeEqual(header.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error('Unsupported backup format. Export a new encrypted OmniVPN backup.');
  }

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(encryptedPath, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(tarPath, { mode: 0o600 })
    );
  } catch {
    fs.rmSync(tarPath, { force: true });
    throw new Error('Backup authentication failed. The file is corrupt or uses a different passphrase.');
  }
}

function validateEntry(entry) {
  const normalized = path.posix.normalize(entry.path).replace(/^\.\//, '');
  if (!normalized || normalized === '.') return;
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe backup path: ${entry.path}`);
  }
  const root = normalized.split('/')[0];
  if (!ALLOWED_ROOTS.has(root) && !ALLOWED_FILES.has(normalized)) {
    throw new Error(`Unexpected backup entry: ${entry.path}`);
  }
  if (!['File', 'Directory'].includes(entry.type)) {
    throw new Error(`Backup links and special files are not allowed: ${entry.path}`);
  }
}

async function validateAndExtract(tarPath, extractDir) {
  let entries = 0;
  let expandedBytes = 0;
  await tar.t({
    file: tarPath,
    strict: true,
    onentry(entry) {
      validateEntry(entry);
      entries += 1;
      expandedBytes += Number(entry.size) || 0;
      if (entries > MAX_ENTRIES) throw new Error('Backup contains too many files.');
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Backup expands beyond the 1 GB safety limit.');
    }
  });
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  await tar.x({ file: tarPath, cwd: extractDir, preservePaths: false, strict: true });
}

module.exports = { createEncryptedArchive, decryptArchive, validateAndExtract };
