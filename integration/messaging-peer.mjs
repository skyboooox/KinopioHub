import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export function childPeer(executable, args) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, stderr = '', stopped = false;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  lines.on('line', line => {
    let row;
    try { row = JSON.parse(line); } catch { fail(Error(`Invalid peer output: ${line}`)); return; }
    const entry = pending.get(row.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(row.id);
    if (row.error) entry.reject(Object.assign(Error(row.error.message), { code: row.error.code }));
    else entry.resolve(row.result);
  });
  child.on('error', fail);
  child.stdin.on('error', fail);
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    stopped = true; fail(Error(`Peer ended (${code ?? signal}): ${stderr}`)); resolve();
  }));
  const call = (op, fields = {}) => new Promise((resolve, reject) => {
    if (stopped) { reject(Error(`Peer already stopped: ${stderr}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Peer ${op} deadline: ${stderr}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
  });
  return { call, async close() {
    if (stopped) return;
    try { await Promise.race([call('close'), delay(2000)]); } catch {}
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await ended; clearTimeout(timer); lines.close();
  } };
}
