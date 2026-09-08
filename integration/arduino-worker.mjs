import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function serialWorker(port = process.env.KINOPIO_SERIAL, python = process.env.KINOPIO_PYTHON ?? 'python3') {
  if (!port) throw Error('Set KINOPIO_SERIAL to the ESP32 serial device.');
  const child = spawn(python, [fileURLToPath(new URL('./arduino-serial.py', import.meta.url)), port], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0, stopped = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; } // ESP32 boot messages are not protocol replies.
    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(response.id);
    response.error ? entry.reject(Error(response.error)) : entry.resolve(response.result);
  });
  function failPending(error) {
    stopped = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  child.on('error', failPending);
  child.on('exit', code => failPending(Error(`Serial bridge exited (${code})`)));
  child.stdin.on('error', failPending);
  function call(op, fields = {}) {
    return new Promise((resolve, reject) => {
      if (stopped) { reject(Error('Serial bridge is closed')); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`ESP32 ${op} timed out`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
    });
  }
  return { call, close() { child.stdin.end(); child.kill(); lines.close(); failPending(Error('Test completed')); } };
}

// Test-fixture clock setup is explicit; the SDK never changes the system clock.
export async function setTestClock(call) {
  await call('clock', { start: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await call('clock')).ready) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const clock = await call('clock', { unixTime: Math.floor(Date.now() / 1000) });
  if (!clock.ready) throw Error('ESP32 test clock initialization failed');
}
