import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startIPv6Transport, normalizeGatewayIPs } from '../src/ipv6-transport.js';

test('normalizeGatewayIPs accepts IPv4/IPv6 lists and reports invalid entries', () => {
  assert.deepEqual(normalizeGatewayIPs('104.16.1.1, 2606:4700::6810:84e5,104.16.1.1'), { ips: ['104.16.1.1', '2606:4700::6810:84e5'], invalid: [] });
  assert.deepEqual(normalizeGatewayIPs(['104.16.1.1', 'example.com', '999.1.1.1', '']).invalid, ['example.com', '999.1.1.1']);
  assert.deepEqual(normalizeGatewayIPs('').ips, []);
});

test('gateway IPs are tried first and a failed IP advances to the next candidate', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => echo.close());
  const connect = net.connect;
  const attempts = [];
  t.mock.method(net, 'connect', (options, callback) => {
    attempts.push(options);
    if (options.host === '203.0.113.1') {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
      return socket;
    }
    return connect({ host: '127.0.0.1', port: echo.address().port }, callback);
  });
  const transport = await startIPv6Transport({ gatewayIPs: ['203.0.113.1', '198.51.100.7'] });
  t.after(() => transport.stop());
  const client = connectClient(Number(new URL(transport.env.HTTPS_PROXY).port), 'opencode.ai:443');
  assert.match((await once(client, 'data'))[0].toString(), /200 Connection Established/);
  client.write('via-gateway-ip');
  assert.equal((await once(client, 'data'))[0].toString(), 'via-gateway-ip');
  client.destroy();
  assert.deepEqual(attempts.map(a => a.host), ['203.0.113.1', '198.51.100.7']);
  assert.equal(attempts[0].port, 443, 'Gateway IPs connect on the HTTPS port');
});

test('when every gateway IP fails, the chain still reaches the resolved families', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => echo.close());
  const connect = net.connect;
  const attempts = [];
  t.mock.method(net, 'connect', (options, callback) => {
    attempts.push(options);
    if (options.host === '203.0.113.1') {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
      return socket;
    }
    if (options.family === 6) {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error('unreach'), { code: 'ENETUNREACH' })));
      return socket;
    }
    return connect({ host: '127.0.0.1', port: echo.address().port }, callback);
  });
  const logs = [];
  const transport = await startIPv6Transport({ gatewayIPs: ['203.0.113.1'], log: message => logs.push(message) });
  t.after(() => transport.stop());
  const client = connectClient(Number(new URL(transport.env.HTTPS_PROXY).port), 'opencode.ai:443');
  assert.match((await once(client, 'data'))[0].toString(), /200 Connection Established/);
  client.destroy();
  assert.deepEqual(attempts.map(a => [a.host, a.family ?? null]), [['203.0.113.1', null], ['opencode.ai', 6], ['opencode.ai', null]]);
});


function connectClient(port, target) {
  const client = net.createConnection({ port, host: '127.0.0.1' });
  client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  return client;
}

test('direct transport requests IPv6, preserves tunnel bytes, and closes active sockets', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '::1', resolve));
  t.after(() => echo.close());
  const connect = net.connect;
  let selected;
  t.mock.method(net, 'connect', (options, callback) => {
    selected = options;
    return connect({ host: '::1', port: echo.address().port, family: 6 }, callback);
  });
  const transport = await startIPv6Transport();
  t.after(() => transport.stop());
  const client = connectClient(Number(new URL(transport.env.HTTPS_PROXY).port), 'opencode.ai:443');
  assert.match((await once(client, 'data'))[0].toString(), /200 Connection Established/);
  assert.deepEqual(selected, { host: 'opencode.ai', port: 443, family: 6 });
  client.write('encrypted-byte-test');
  assert.equal((await once(client, 'data'))[0].toString(), 'encrypted-byte-test');
  const closed = once(client, 'close');
  await transport.stop(); await closed;
  await transport.stop();
});

test('unrelated hosts and non-HTTPS ports are still rejected', async t => {
  const transport = await startIPv6Transport();
  t.after(() => transport.stop());
  const port = Number(new URL(transport.env.HTTPS_PROXY).port);
  const request = async target => {
    const client = connectClient(port, target);
    const response = (await once(client, 'data'))[0].toString();
    client.destroy(); return response;
  };
  assert.match(await request('example.com:443'), /403/);
  assert.match(await request('opencode.ai:80'), /403/);
});

test('a local IPv6 routing failure falls back to default address selection', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => echo.close());
  const connect = net.connect;
  const attempts = [];
  t.mock.method(net, 'connect', (options, callback) => {
    attempts.push(options);
    if (options.family === 6) {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error('fail'), { code: 'ENETUNREACH' })));
      return socket;
    }
    return connect({ host: '127.0.0.1', port: echo.address().port }, callback);
  });
  const logs = [];
  const transport = await startIPv6Transport(message => logs.push(message));
  t.after(() => transport.stop());
  const client = connectClient(Number(new URL(transport.env.HTTPS_PROXY).port), 'opencode.ai:443');
  assert.match((await once(client, 'data'))[0].toString(), /200 Connection Established/);
  client.write('roundtrip-after-fallback');
  assert.equal((await once(client, 'data'))[0].toString(), 'roundtrip-after-fallback');
  client.destroy();
  assert.deepEqual(attempts, [{ host: 'opencode.ai', port: 443, family: 6 }, { host: 'opencode.ai', port: 443 }]);
  assert.ok(logs.some(l => l.includes('falling back')), 'fallback should be logged');
});

test('after one fallback, later tunnels skip the IPv6 attempt entirely', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => echo.close());
  const connect = net.connect;
  const attempts = [];
  t.mock.method(net, 'connect', (options, callback) => {
    attempts.push(options);
    if (options.family === 6) {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error('fail'), { code: 'ENOENT' })));
      return socket;
    }
    return connect({ host: '127.0.0.1', port: echo.address().port }, callback);
  });
  const transport = await startIPv6Transport();
  t.after(() => transport.stop());
  const port = Number(new URL(transport.env.HTTPS_PROXY).port);
  const first = connectClient(port, 'opencode.ai:443');
  assert.match((await once(first, 'data'))[0].toString(), /200 Connection Established/);
  first.destroy();
  const second = connectClient(port, 'opencode.ai:443');
  assert.match((await once(second, 'data'))[0].toString(), /200 Connection Established/);
  second.destroy();
  assert.deepEqual(attempts, [
    { host: 'opencode.ai', port: 443, family: 6 },
    { host: 'opencode.ai', port: 443 },
    { host: 'opencode.ai', port: 443 },
  ]);
});

test('a remote refusal over IPv6 does not downgrade the address family', async t => {
  const connect = net.connect;
  const attempts = [];
  t.mock.method(net, 'connect', (options, callback) => {
    attempts.push(options);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return socket;
  });
  const transport = await startIPv6Transport();
  t.after(() => transport.stop());
  const client = connectClient(Number(new URL(transport.env.HTTPS_PROXY).port), 'opencode.ai:443');
  assert.match((await once(client, 'data'))[0].toString(), /502/);
  client.destroy();
  assert.deepEqual(attempts, [{ host: 'opencode.ai', port: 443, family: 6 }]);
});
