import { serialWorker, setTestClock } from './arduino-worker.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export async function arduinoPeer(options) {
  const serial = serialWorker(), kinds = new Map(), received = [], handled = [];
  let sequence = 0;
  const raw = async (op, fields) => {
    try { return await serial.call(op, fields); }
    catch (error) { error.code ??= error.message; throw error; }
  };
  async function collect() {
    const result = await raw('msg_received');
    if (result.dropped) throw Error('ESP32 fixture observation capacity exceeded');
    for (const row of result.messages) {
      if (received.length + handled.length >= 4096) throw Error('Host fixture observation capacity exceeded');
      if (kinds.get(row.key) === 'handle') handled.push({ name: row.topic, data: row.data });
      else received.push({ data: row.data, topic: row.topic, testHeaders: [] });
    }
  }
  try {
    await delay(1000);
    await setTestClock(raw);
    await raw('configure', options);
    const deadline = Date.now() + 45000;
    while ((await raw('status')).connection !== 'connected') {
      if (Date.now() > deadline) throw Error('ESP32 connection deadline');
      await delay(100);
    }
    return {
      async call(op, fields = {}) {
        switch (op) {
          case 'connected': return raw('status');
          case 'subscribe': kinds.set(fields.key, 'sub'); return raw('msg_sub', fields);
          case 'handle': kinds.set(fields.key, 'handle'); return raw('msg_handle', { ...fields, echo: !Object.hasOwn(fields, 'response'), delayMs: (fields.delay ?? 0) * 1000 });
          case 'publish': await raw('msg_pub', fields); await raw('flush'); return null;
          case 'request': {
            const data = await raw('msg_req', { ...fields, key: `req-${++sequence}`, timeoutMs: (fields.timeout ?? 3) * 1000 });
            return { data, testHeaders: [] };
          }
          case 'unsubscribe': await raw('msg_unsubscribe', fields); await raw('flush'); return null;
          case 'snapshot': {
            await collect();
            const result = { received: [...received], handled: [...handled], status: await raw('status') };
            if (fields.clear) { received.length = 0; handled.length = 0; }
            return result;
          }
          case 'drain': return raw('msg_drain', { timeoutMs: (fields.timeout ?? 5) * 1000 });
          default: return raw(op, fields);
        }
      },
      async close() { try { await raw('disconnect'); } finally { serial.close(); } },
    };
  } catch (error) { serial.close(); throw error; }
}
