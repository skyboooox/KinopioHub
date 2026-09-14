import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { messageSubject } from '../../KinopioHub.JS/src/messaging.mjs';

export async function messageConformance(call) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/message-vectors.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const vector of fixture.cases) {
    for (const pattern of [false, true]) {
      const valid = vector[pattern ? 'subscribe' : 'publish'];
      const js = () => messageSubject(fixture.namespace, vector.name, pattern);
      const fields = { namespace: fixture.namespace, name: vector.name, pattern };
      if (valid) {
        assert.equal(js(), vector.subject);
        assert.equal(await call('encode', fields), vector.subject);
      } else {
        assert.throws(js, error => error.code === 'INVALID_TOPIC');
        await assert.rejects(call('encode', fields), error => error.code === 'INVALID_TOPIC');
      }
      checked += 2;
    }
  }
  assert.equal(await call('encode', { namespace: fixture.namespace, name: fixture.queue.name, queue: true }), fixture.queue.subject);
  return checked + 1;
}
