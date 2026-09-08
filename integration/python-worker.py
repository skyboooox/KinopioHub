"""JSON-line fixture used by the JavaScript/Python integration runner."""
import asyncio
import json
import sys

from kinopio_hub import KinopioHub, UNSET


async def main():
    options = json.loads(sys.argv[1])
    async with KinopioHub(**options) as hub:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            try:
                operation = request["op"]
                if operation == "connected":
                    await hub.connected(timeout=30)
                    result = hub.status()
                elif operation == "status":
                    result = hub.status()
                elif operation == "instances":
                    result = await hub.instances.list()
                elif operation == "close":
                    print(json.dumps({"id": request["id"], "result": None}), flush=True)
                    break
                else:
                    variable = hub.scope(request.get("scope", "devices")).var(request.get("name", "battery"))
                    if operation == "set":
                        await variable.set(request["value"])
                        await hub.flush(timeout=10)
                    elif operation == "delete":
                        await variable.delete()
                        await hub.flush(timeout=10)
                    elif operation != "get":
                        raise ValueError("Unknown fixture operation")
                    result = {"meta": variable.meta}
                    if variable.value is not UNSET:
                        result["value"] = variable.value
                print(json.dumps({"id": request["id"], "result": result}, ensure_ascii=False), flush=True)
            except Exception as error:
                print(json.dumps({"id": request["id"], "error": f"{operation}: {error}; status={hub.status()}"}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
