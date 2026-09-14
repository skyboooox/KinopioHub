"""Bounded JSON-line peer for public messaging interoperability checks."""

import asyncio
import json
import sys

from kinopio_hub import KinopioHub
from kinopio_hub._messaging import subject, queue_name


async def main():
    options = json.loads(sys.argv[1])
    hub = KinopioHub(**options)
    subscriptions = {}
    received = []
    handled = []

    def remember(rows, value):
        if len(rows) >= 4096:
            raise RuntimeError("Fixture observation capacity exceeded")
        rows.append(value)

    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            command = json.loads(line)
            operation = command["op"]
            try:
                result = None
                ref = None if operation == "encode" else hub.var(command.get("name", "battery"))
                if operation == "encode":
                    result = (queue_name(command["namespace"], command["name"])
                              if command.get("queue") else
                              subject(command["namespace"], command["name"], command.get("pattern", False)))
                elif operation == "connected":
                    await hub.connected(timeout=15)
                    result = hub.status()
                elif operation == "instances":
                    result = await hub.instances.list()
                elif operation == "subscribe":
                    async def receive(data, context):
                        remember(received, {
                            "data": data,
                            "topic": context.topic,
                            "testHeaders": context.headers.get_all("x-test"),
                        })
                    subscriptions[command["key"]] = await ref.sub(
                        receive, queue=command.get("queue"), with_context=True
                    )
                elif operation == "handle":
                    async def respond(data, context, settings=command):
                        remember(handled, {"name": settings["name"], "data": data})
                        if settings.get("delay"):
                            await asyncio.sleep(settings["delay"])
                        context.reply_headers = settings.get("headers")
                        return settings.get("response", data)
                    subscriptions[command["key"]] = await ref.handle(
                        respond, queue=command.get("queue"), with_context=True
                    )
                elif operation == "reply_many":
                    async def replies(data, context, settings=command):
                        for response in settings["responses"]:
                            await context.reply(response, headers=settings.get("headers"))
                    subscriptions[command["key"]] = await ref.sub(
                        replies, with_context=True
                    )
                elif operation == "publish":
                    await ref.pub(command["data"], headers=command.get("headers"))
                    await hub.flush()
                elif operation == "request":
                    reply = await ref.req(
                        command.get("data"), timeout=command.get("timeout", 3),
                        headers=command.get("headers"), details=True,
                    )
                    result = {"data": reply.data,
                              "testHeaders": reply.headers.get_all("X-Test")}
                elif operation == "request_many":
                    replies = await ref.request_many(
                        command.get("data"), timeout=command.get("timeout", 0.3),
                        max_replies=command.get("maxReplies", 16), details=True,
                    )
                    result = {"data": [reply.data for reply in replies.replies],
                              "reason": replies.reason}
                elif operation == "unsubscribe":
                    await subscriptions.pop(command["key"]).unsubscribe()
                elif operation == "set":
                    await ref.set(command["data"])
                    await hub.flush()
                elif operation == "get":
                    result = {"data": ref.get(command.get("fallback")), "meta": ref.meta}
                elif operation == "snapshot":
                    result = {"received": list(received), "handled": list(handled),
                              "status": hub.status()}
                    if command.get("clear"):
                        received.clear()
                        handled.clear()
                elif operation == "drain":
                    await hub.drain(timeout=command.get("timeout", 5))
                elif operation == "close":
                    await hub.close()
                else:
                    raise ValueError(f"Unknown fixture operation: {operation}")
                print(json.dumps({"id": command["id"], "result": result},
                                 ensure_ascii=False), flush=True)
                if operation in ("close", "drain"):
                    break
            except Exception as error:
                print(json.dumps({"id": command["id"], "error": {
                    "code": getattr(error, "code", type(error).__name__),
                    "message": str(error),
                }}, ensure_ascii=False), flush=True)
    finally:
        await hub.close()


if __name__ == "__main__":
    asyncio.run(main())
