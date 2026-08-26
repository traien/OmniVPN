const assert = require('node:assert/strict');
const test = require('node:test');
const { isPrivateIp } = require('../geoip');

test('private address detection covers complete RFC1918 and local IPv6 ranges', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.2.3', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
});
