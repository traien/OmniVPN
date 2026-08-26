const { execFile, execFileSync } = require('child_process');

const VPN_CONTAINER = process.env.VPN_CONTAINER || 'ipsec-vpn-server';
const CONTAINER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

if (!CONTAINER_PATTERN.test(VPN_CONTAINER)) {
  throw new Error('VPN_CONTAINER contains unsupported characters.');
}

function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      timeout: options.timeout || 15_000,
      windowsHide: true
    }, (error, stdout = '', stderr = '') => {
      resolve({
        success: !error,
        output: stdout.trim(),
        raw: stdout,
        error: error ? (stderr.trim() || error.message) : ''
      });
    });
  });
}

function runFileSync(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: options.encoding || 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout || 30_000,
    windowsHide: true
  });
}

function runDockerExec(args, options) {
  return runFile('docker', ['exec', VPN_CONTAINER, ...args], options);
}

function runDockerExecSync(args, options) {
  return runFileSync('docker', ['exec', VPN_CONTAINER, ...args], options);
}

function restartContainer(name) {
  if (!CONTAINER_PATTERN.test(name)) throw new Error('Invalid container name.');
  return runFile('docker', ['restart', name], { timeout: 60_000 });
}

module.exports = {
  VPN_CONTAINER,
  restartContainer,
  runDockerExec,
  runDockerExecSync,
  runFile,
  runFileSync
};
