// The same fixture runs in Node and a real browser. No wire protocol is mocked.
export function sdkPeer(hub) {
  const subscriptions = new Map(), received = [], handled = [];
  const remember = (rows, value) => {
    if (rows.length >= 4096) throw Error('Fixture observation capacity exceeded');
    rows.push(value);
  };
  return {
    async call(op, command = {}) {
      const ref = hub.var(command.name ?? 'battery');
      switch (op) {
        case 'connected': await hub.connected(); return hub.status();
        case 'instances': return hub.instances.list();
        case 'subscribe': {
          const subscription = await ref.sub((data, context) => {
            remember(received, { data, topic: context.topic, testHeaders: context.headers.getAll('x-test') });
          }, command.queue === undefined ? {} : { queue: command.queue });
          subscriptions.set(command.key, subscription);
          return null;
        }
        case 'handle': {
          const subscription = await ref.handle(async (data, context) => {
            remember(handled, { name: command.name, data });
            if (command.delay) await new Promise(resolve => setTimeout(resolve, command.delay * 1000));
            context.replyHeaders = command.headers ?? {};
            return Object.hasOwn(command, 'response') ? command.response : data;
          }, command.queue === undefined ? {} : { queue: command.queue });
          subscriptions.set(command.key, subscription);
          return null;
        }
        case 'reply_many': {
          subscriptions.set(command.key, await ref.sub(async (_, context) => {
            for (const data of command.responses) await context.reply(data, { headers: command.headers });
          }));
          return null;
        }
        case 'publish': await ref.pub(command.data, { headers: command.headers }); await hub.flush(); return null;
        case 'request': {
          const reply = await ref.req(command.data ?? null, { timeout: (command.timeout ?? 3) * 1000, headers: command.headers, details: true });
          return { data: reply.data, testHeaders: reply.headers.getAll('x-test') };
        }
        case 'request_many': {
          const result = await ref.requestMany(command.data ?? null, { timeout: (command.timeout ?? 3) * 1000, maxReplies: command.maxReplies ?? 16, details: true });
          return { data: result.replies.map(reply => reply.data), reason: result.reason };
        }
        case 'unsubscribe': subscriptions.get(command.key)?.unsubscribe(); subscriptions.delete(command.key); await hub.flush(); return null;
        case 'snapshot': {
          const result = { received: [...received], handled: [...handled], status: hub.status() };
          if (command.clear) { received.length = 0; handled.length = 0; }
          return result;
        }
        case 'drain': await hub.drain({ timeout: (command.timeout ?? 5) * 1000 }); return null;
        case 'close': await hub.close(); return null;
        default: throw Error(`Unknown fixture operation: ${op}`);
      }
    },
    close: () => hub.close(),
  };
}
