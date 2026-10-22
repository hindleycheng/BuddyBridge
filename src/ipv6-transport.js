import http from 'node:http';
import net from 'node:net';

// Keep TLS end-to-end while steering OpenCode's HTTPS connections to IPv6 first.
// A machine without IPv6 routing must still work: a local address-family failure
// (no route, no resolver record) falls back to default selection instead of
// failing every request. Remote rejections do not change the address family.
export async function startIPv6Transport(log = () => {}) {
  let ipv6Broken = false;
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
    const state = { connected: false, family: null, socket: null };
    const attempt = family => {
      state.family = family;
      const socket = track(net.connect({ host: target.hostname, port: 443, ...(family ? { family } : {}) }, () => {
        state.connected = true;
        log(`${family === 6 ? 'IPv6' : 'Default'} direct ${target.hostname} -> ${socket.remoteAddress}`);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        client.pipe(socket); socket.pipe(client);
      }));
      socket.on('close', () => { if (state.connected) client.destroy(); });
      state.socket = socket;
      return socket;
    };
    const fail = (label, error) => {
      log(`${label} connection failed ${target.hostname}: ${error.code || error.message}`);
      if (!state.connected) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    };
    attempt(ipv6Broken ? undefined : 6);
    state.socket.on('error', error => {
      if (state.connected) { client.destroy(); return; }
      log(`IPv6 direct failed ${target.hostname}: ${error.code || error.message}`);
      // Only an immediate local address-family failure proves IPv6 is unusable;
      // refused or reset remote connections must not downgrade later attempts.
      if (state.family === 6 && ['ENOENT', 'ENOTFOUND', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EPFNOSUPPORT', 'EAFNOSUPPORT'].includes(error.code)) {
        ipv6Broken = true;
        log('IPv6 unavailable on this machine; falling back to default address selection');
        attempt(undefined);
        state.socket.on('error', fallbackError => fail('Default', fallbackError));
      } else fail('IPv6', error);
    });
    client.on('error', () => state.socket?.destroy());
    client.on('close', () => state.socket?.destroy());
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
