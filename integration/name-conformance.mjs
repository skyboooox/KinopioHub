import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { token, PROTOCOL } from '../../KinopioHub.JS/src/protocol.mjs';

export async function nameConformance(hub, call) {
  const vectors = JSON.parse(await readFile(new URL('./fixtures/name-vectors.json', import.meta.url), 'utf8'));
  assert.equal(PROTOCOL, vectors.protocol);
  for (const [index, { name, hex }] of vectors.valid.entries()) {
    assert.equal(token(name), hex);
    const variable = hub.var(name);
    assert.equal(hub.var(name), variable);
    const sent = { index, name };
    await variable.set(sent);
    await hub.flush();
    let remote;
    const end = Date.now() + 10000;
    do {
      remote = await call('get', { name });
      if (remote.value?.index === index && remote.value?.name === name) break;
      await delay(25);
    } while (Date.now() < end);
    assert.deepEqual(remote.value, sent, `Remote name mismatch: ${JSON.stringify(name)}`);
    await call('set', { name, value: index });
    const replyEnd = Date.now() + 10000;
    while (variable.value !== index && Date.now() < replyEnd) await delay(25);
    assert.equal(variable.value, index, `Reply name mismatch: ${JSON.stringify(name)}`);
  }
  for (const name of vectors.invalid) assert.throws(() => hub.var(name));
  return vectors.valid.length;
}
