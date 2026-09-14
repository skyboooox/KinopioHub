import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureManagedBroker } from '../../KinopioHub.JS/src/mesh-broker.mjs';

function endpointOf(value) {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(endpoint.protocol === 'wss:' || endpoint.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))) {
    throw new Error('Use a credential-free WSS endpoint; WS is only allowed on loopback');
  }
  return endpoint;
}

// Test-only configuration adapter: TLS and the original WSS endpoint remain
// end to end. Official NATS HTTP CONNECT proxy settings cover every reconnect.
export async function createPinnedBroker({ upstream, proxy }) {
  const endpoint = endpointOf(upstream);
  const gate = new URL(proxy);
  if (gate.protocol !== 'http:' || gate.hostname !== '127.0.0.1' || !gate.port ||
      gate.username || gate.password || gate.search || gate.hash || gate.pathname !== '/') {
    throw new Error('Pinned broker requires the loopback HTTP CONNECT proxy URL');
  }
  if (typeof process.execve !== 'function') throw new Error('Pinned broker requires Node execve support');
  const realBinary = await ensureManagedBroker();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kinopio-pinned-gate-'));
  try {
    const runner = path.join(directory, 'runner.mjs');
    const source = `import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const realBinary = ${JSON.stringify(realBinary)};
const directory = ${JSON.stringify(directory)};
const upstream = ${JSON.stringify(endpoint.href)};
const proxy = ${JSON.stringify(gate.href)};
const args = process.argv.slice(2);
try {
  if (!(args.length === 1 && args[0] === '-v')) {
    if (args.length !== 2 || args[0] !== '-c') throw Error();
    const input = path.resolve(args[1]);
    const parent = path.dirname(input);
    if (path.basename(input) !== 'nats.json' || !path.basename(parent).startsWith('kinopio-managed-') ||
        fs.realpathSync(path.dirname(parent)) !== fs.realpathSync(os.tmpdir()) ||
        fs.lstatSync(input).isSymbolicLink() || fs.lstatSync(parent).isSymbolicLink()) throw Error();
    const config = JSON.parse(fs.readFileSync(input, 'utf8'));
    const remotes = config.leafnodes?.remotes;
    if (!Array.isArray(remotes) || remotes.length !== 1 || !Array.isArray(remotes[0].urls) || remotes[0].urls.length !== 1) throw Error();
    const target = new URL(remotes[0].urls[0]);
    target.username = ''; target.password = '';
    if (target.href !== upstream) throw Error();
    remotes[0].ignore_discovered_servers = true;
    remotes[0].proxy = { url: proxy, timeout: '5s' };
    const output = path.join(directory, 'pinned-' + process.pid + '.json');
    fs.writeFileSync(output, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    args[1] = output;
  }
  process.execve(realBinary, [realBinary, ...args], process.env);
} catch {
  console.error('Pinned broker rejected configuration or could not start');
  process.exitCode = 1;
}
`;
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const binary = path.join(directory, 'nats-server');
    await fs.writeFile(runner, source, { mode: 0o600 });
    await fs.writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`, { mode: 0o700 });
    return { binary, close: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// A fixed-destination CONNECT gate. TLS, WebSocket negotiation and NATS S2
// remain opaque. It neither terminates TLS nor rewrites NATS protocol messages.
export async function startLink({ upstream }) {
  const endpoint = endpointOf(upstream);
  const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
  const authority = `${endpoint.hostname}:${port}`.toLowerCase();
  let enabled = true, closing = false, closePromise;
  const pairs = new Set(), sockets = new Map();
  const totals = {
    acceptedConnections: 0, upstreamConnections: 0, rejectedConnections: 0,
    cuts: 0, restores: 0, errors: 0, limitClosures: 0,
    rejectedTargets: 0, malformedRequests: 0, handshakeTimeouts: 0, connectionErrors: 0,
    upstreamChunks: 0, upstreamBytes: 0, downstreamChunks: 0, downstreamBytes: 0,
  };
  const track = socket => {
    sockets.set(socket, new Promise(resolve => socket.once('close', () => {
      sockets.delete(socket); resolve();
    })));
    return socket;
  };
  const server = net.createServer({ highWaterMark: 64 * 1024 }, local => {
    track(local);
    if (!enabled || closing || pairs.size >= 64) {
      totals.rejectedConnections++;
      if (pairs.size >= 64) totals.limitClosures++;
      local.on('error', () => {});
      local.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      local.setTimeout(1000, () => local.destroy());
      return;
    }
    totals.acceptedConnections++;
    const pair = { local, remote: null, stopped: false };
    pairs.add(pair);
    let timer;
    const stop = () => {
      if (pair.stopped) return;
      pair.stopped = true; clearTimeout(timer);
      pairs.delete(pair);
      local.destroy(); pair.remote?.destroy();
    };
    pair.stop = stop;
    const fail = () => { if (!pair.stopped) { totals.errors++; totals.connectionErrors++; } stop(); };
    const reject = (code, counter) => {
      totals[counter]++;
      local.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      local.setTimeout(1000, stop);
    };
    local.on('error', fail).on('close', stop);
    timer = setTimeout(() => { totals.handshakeTimeouts++; stop(); }, 5000);
    let header = Buffer.alloc(0);
    const readHeader = chunk => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if ((end < 0 && header.length > 16384) || end > 16384) { totals.limitClosures++; stop(); return; }
      if (end < 0) return;
      local.pause();
      local.removeListener('data', readHeader);
      const lines = header.subarray(0, end).toString('latin1').split('\r\n');
      const match = /^CONNECT ([^\s]+) HTTP\/1\.[01]$/.exec(lines[0]);
      if (!match || lines.some(line => /^transfer-encoding:/i.test(line) || /^content-length:\s*(?!0\s*$)/i.test(line))) {
        reject('400 Bad Request', 'malformedRequests'); return;
      }
      if (match[1].toLowerCase() !== authority) { reject('403 Forbidden', 'rejectedTargets'); return; }
      const initial = header.subarray(end + 4);
      header = null;
      // Never dial a value supplied by CONNECT: the configured destination is
      // the only destination, even if an alternative address is advertised.
      pair.remote = track(net.connect({
        host: endpoint.hostname.replace(/^\[|\]$/g, ''), port, highWaterMark: 64 * 1024,
      }, () => {
        if (!enabled || pair.stopped) { stop(); return; }
        clearTimeout(timer);
        totals.upstreamConnections++;
        pair.remote.on('data', data => { if (!pair.stopped) { totals.downstreamChunks++; totals.downstreamBytes += data.length; } });
        local.on('data', data => { if (!pair.stopped) { totals.upstreamChunks++; totals.upstreamBytes += data.length; } });
        local.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        pair.remote.pipe(local);
        const forward = () => { if (!pair.stopped) local.pipe(pair.remote); };
        if (initial.length) {
          totals.upstreamChunks++; totals.upstreamBytes += initial.length;
          pair.remote.write(initial, error => error ? fail() : forward());
        } else forward();
      }));
      pair.remote.on('error', fail).on('close', stop);
    };
    local.on('data', readHeader);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    cut() { if (!closing && enabled) { enabled = false; totals.cuts++; for (const pair of pairs) pair.stop(); } },
    restore() { if (!closing && !enabled) { enabled = true; totals.restores++; } },
    // Counts tunnel bytes (including TLS and WebSocket); excludes CONNECT headers.
    stats() { return { ...totals, enabled, closed: closing, activeConnections: pairs.size }; },
    close() {
      if (closePromise) return closePromise;
      closing = true; enabled = false;
      closePromise = Promise.all([...sockets.values(), new Promise(resolve => server.close(resolve))]).then(() => {});
      for (const pair of pairs) pair.stop();
      for (const socket of sockets.keys()) socket.destroy();
      return closePromise;
    },
  };
}
