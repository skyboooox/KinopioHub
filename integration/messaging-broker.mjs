import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureManagedBroker } from '../../KinopioHub.JS/src/mesh-broker.mjs';

const exec = promisify(execFile);

// A temporary authenticated TLS endpoint and a loopback-only browser endpoint.
export async function messagingBroker(host = '127.0.0.1') {
  if (net.isIP(host) !== 4) throw Error('KINOPIO_TEST_HOST must be an IPv4 address');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kinopio-messaging-'));
  const file = name => path.join(directory, name);
  let child, ended, stderr = '';
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await ended; clearTimeout(timer);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  try {
    const binary = process.env.KINOPIO_TEST_BROKER_BINARY ?? await ensureManagedBroker(), token = randomUUID();
    const version = (await exec(binary, ['-v'], { timeout: 5000 })).stdout.trim();
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '1', '-subj', '/CN=Kinopio messaging test CA']);
    await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=Kinopio messaging fixture']);
    await fs.writeFile(file('extensions'), `subjectAltName=IP:${host}\nextendedKeyUsage=serverAuth\n`);
    await exec('openssl', ['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'), '-days', '1', '-extfile', file('extensions')]);
    await fs.writeFile(file('nats.json'), JSON.stringify({ host, port: -1, ports_file_dir: directory,
      authorization: { token, ...(process.env.KINOPIO_TEST_REJECT_FIRST_WILDCARD === '1' ? { reject_first_wildcard: true } : {}) }, max_payload: 1048576,
      tls: { cert_file: file('server.pem'), key_file: file('server.key'), handshake_first: true },
      websocket: { host: '127.0.0.1', port: -1, no_tls: true },
    }), { mode: 0o600 });
    child = spawn(binary, ['-c', file('nats.json')], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
    ended = new Promise(resolve => child.once('exit', resolve));
    let ports;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw Error(`Fixture broker exited: ${stderr}`);
      const name = (await fs.readdir(directory)).find(name => name.endsWith('.ports'));
      if (name) { ports = JSON.parse(await fs.readFile(file(name), 'utf8')); break; }
      await delay(25);
    }
    if (!ports) throw Error('Fixture broker startup deadline');
    return { url: `tls://${host}:${new URL(ports.nats[0]).port}`, websocketUrl: ports.websocket[0],
      token, version, caFile: file('ca.pem'), ca: await fs.readFile(file('ca.pem'), 'utf8'), close };
  } catch (error) { await close(); throw error; }
}
