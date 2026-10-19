import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startIPv6Transport } from '../src/ipv6-transport.js';

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
  const client = connect(Number(new URL(transport.env.HTTPS_PROXY).port), '127.0.0.1');
  client.write('CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\n\r\n');
  assert.match((await once(client, 'data'))[0].toString(), /200 Connection Established/);
  assert.deepEqual(selected, { host: 'opencode.ai', port: 443, family: 6 });
  client.write('encrypted-byte-test');
  assert.equal((await once(client, 'data'))[0].toString(), 'encrypted-byte-test');
  const closed = once(client, 'close');
  await transport.stop(); await closed;
  await transport.stop();
});

test('direct transport rejects unrelated hosts and reports failed IPv6 connections', async t => {
  const transport = await startIPv6Transport();
  t.after(() => transport.stop());
  const request = async target => {
    const client = net.createConnection({ port: Number(new URL(transport.env.HTTPS_PROXY).port), host: '127.0.0.1' });
    client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const response = (await once(client, 'data'))[0].toString();
    client.destroy(); return response;
  };
  assert.match(await request('example.com:443'), /403/);
  assert.match(await request('opencode.ai:80'), /403/);
  t.mock.method(net, 'connect', () => {
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error('no IPv6'), { code: 'ENETUNREACH' })));
    return socket;
  });
  assert.match(await request('opencode.ai:443'), /502/);
});
