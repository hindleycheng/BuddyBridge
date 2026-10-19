import http from 'node:http';
import net from 'node:net';

// Keep TLS end-to-end while selecting IPv6 for OpenCode's HTTPS connections.
export async function startIPv6Transport(log = () => {}) {
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    let target;
    try { target = new URL(`https://${req.url}`); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if ((target.port && target.port !== '443') || target.username || target.password ||
        !(target.hostname === 'opencode.ai' || target.hostname.endsWith('.opencode.ai'))) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    let connected = false;
    const upstream = track(net.connect({ host: target.hostname, port: 443, family: 6 }, () => {
      connected = true;
      log(`IPv6 direct ${target.hostname} -> ${upstream.remoteAddress}`);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    }));
    upstream.on('error', error => {
      log(`IPv6 direct failed ${target.hostname}: ${error.code || error.message}`);
      if (!connected) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { if (connected) client.destroy(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  let stopping;
  return {
    env: { HTTP_PROXY: address, HTTPS_PROXY: address, http_proxy: address, https_proxy: address,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' },
    stop() {
      return stopping ??= new Promise(resolve => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
