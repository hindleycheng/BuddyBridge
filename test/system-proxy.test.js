import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseSystemProxy, parseWindowsProxy, systemProxyEnvironment, probeProxyAddress } from '../src/system-proxy.js';

test('system proxy maps HTTP and HTTPS and bypasses local services', () => {
  const env = parseSystemProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7892\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7892');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('off does not inherit proxy; unsupported or invalid system config fails explicitly', async () => {
  assert.equal((await systemProxyEnvironment(false)).HTTPS_PROXY, undefined);
  assert.throws(() => parseSystemProxy('SOCKSEnable : 1'), /HTTPS/);
  assert.throws(() => parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999'), /无效/);
});

test('parseWindowsProxy accepts unified and per-protocol forms and rejects disabled state', () => {
  const unified = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7897' });
  assert.equal(unified.HTTPS_PROXY, 'http://127.0.0.1:7897');
  const split = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http=127.0.0.1:7897;https=127.0.0.1:7899' });
  assert.equal(split.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(split.HTTPS_PROXY, 'http://127.0.0.1:7899');
  assert.throws(() => parseWindowsProxy({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7897' }), /启用/);
});

test('a proxy port that accepts connections passes the probe', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = listener.address();
    const env = { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}`,
      http_proxy: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}` };
    assert.deepEqual(await probeProxyAddress(env), env);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('a proxy port that refuses connections is rejected with a clear error', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve)); // port now closed
  const env = { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}`,
    http_proxy: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}` };
  await assert.rejects(() => probeProxyAddress(env), /无法连接/);
});
