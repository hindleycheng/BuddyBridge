import http from 'node:http';
import net from 'node:net';

// Keep TLS end-to-end while steering OpenCode's HTTPS connections through the best
// direct path. Candidate order: user-provided gateway IPs (Cloudflare 优选 IP, each
// tried on any failure), then IPv6-first default resolution, then default selection.
// A machine without IPv6 routing must still work: a local address-family failure
// (no route, no resolver record) falls back to default selection instead of failing
// every request. Remote rejections of the resolved families do not downgrade.
const IPV6_LOCAL_FAILURES = ['ENOENT', 'ENOTFOUND', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EPFNOSUPPORT', 'EAFNOSUPPORT'];

export function normalizeGatewayIPs(input) {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[,\s]+/);
  const ips = [...new Set(raw.map(ip => ip.trim()).filter(Boolean))];
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const invalid = ips.filter(ip => !ipv4.test(ip) && !(ip.includes(':') && !ip.includes('/')));
  return { ips: ips.filter(ip => !invalid.includes(ip)).slice(0, 8), invalid };
}

export async function startIPv6Transport(options = {}, maybeGatewayIPs) {
  // Accept both (logFn) and ({ log, gatewayIPs }) call forms.
  const settings = typeof options === 'function' ? { log: options, gatewayIPs: maybeGatewayIPs } : options;
  const log = settings.log ?? (() => {});
  const gatewayIPs = Array.isArray(settings.gatewayIPs) ? settings.gatewayIPs : [];
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
    // 'advance': any failure moves to the next candidate; 'ipv6': only a local
    // address-family failure may downgrade; 'final': failure closes the tunnel.
    const candidates = [
      ...gatewayIPs.map(ip => ({ host: ip, family: null, label: `Gateway ${ip}`, policy: 'advance' })),
      ...(ipv6Broken ? [] : [{ host: target.hostname, family: 6, label: 'IPv6', policy: 'ipv6' }]),
      { host: target.hostname, family: undefined, label: 'Default', policy: 'final' },
    ];
    const state = { connected: false, socket: null };
    client.on('error', () => state.socket?.destroy());
    client.on('close', () => state.socket?.destroy());
    const fail = () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const attempt = index => {
      const candidate = candidates[index];
      if (!candidate) return fail();
      const socket = track(net.connect({ host: candidate.host, port: 443, ...(candidate.family ? { family: candidate.family } : {}) }, () => {
        state.connected = true;
        socket.setTimeout(0);
        log(`${candidate.label} direct ${target.hostname} -> ${socket.remoteAddress}`);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        client.pipe(socket); socket.pipe(client);
      }));
      state.socket = socket;
      // A blackholed candidate must not hang the tunnel: arm a connect-phase timeout,
      // disabled once established so idle LLM responses never trip it.
      socket.setTimeout(6000);
      socket.on('timeout', () => socket.destroy(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })));
      socket.on('close', () => { if (state.connected) client.destroy(); });
      socket.on('error', error => {
        if (state.connected) { client.destroy(); return; }
        log(`${candidate.label} connection failed ${target.hostname}: ${error.code || error.message}`);
        if (candidate.policy === 'ipv6' && !IPV6_LOCAL_FAILURES.includes(error.code)) return fail();
        if (candidate.policy === 'ipv6') {
          ipv6Broken = true;
          log('IPv6 unavailable on this machine; falling back to default address selection');
        }
        attempt(index + 1);
      });
    };
    attempt(0);
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
