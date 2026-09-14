"""Bounded multi-round Python processor for the edge/Web pilot.

Configuration is one JSON line on stdin so connection credentials never appear in
the process list. stdout is reserved for bounded JSON protocol messages.
"""

import asyncio
import json
import math
import platform
import sys
import time

from kinopio_hub import KinopioHub, UNSET


async def wait_for(predicate, timeout_seconds: float, label: str):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value is not None:
            return value
        await asyncio.sleep(0.05)
    raise TimeoutError(f"Timed out waiting for {label}")


async def main() -> None:
    raw = await asyncio.to_thread(sys.stdin.readline)
    if not raw:
        raise ValueError("Missing stdin configuration")
    config = json.loads(raw)
    timeout = float(config["timeoutSeconds"])
    names = config["names"]
    async with KinopioHub(**config["hubOptions"]) as hub:
        await hub.connected(timeout=timeout)
        parameter = hub.var(names["parameter"])
        sample = hub.var(names["sample"])
        result = hub.var(names["result"])
        print(json.dumps({"event": "ready", "runtime": f"python/{platform.python_version()}"}), flush=True)

        completed_round = 0
        for _ in range(int(config["rounds"])):
            def matching_inputs():
                left, right = parameter.value, sample.value
                if left is UNSET or right is UNSET or not isinstance(left, dict) or not isinstance(right, dict):
                    return None
                if left.get("runId") != config["runId"] or right.get("runId") != config["runId"]:
                    return None
                if left.get("token") != config["token"] or right.get("token") != config["token"]:
                    return None
                request_round, sample_sequence = left.get("round"), right.get("sequence")
                if not isinstance(request_round, int) or isinstance(request_round, bool) or not isinstance(sample_sequence, int) or isinstance(sample_sequence, bool):
                    return None
                current_round = max(request_round, sample_sequence)
                return (left, right, current_round) if current_round > completed_round else None

            request, produced, current_round = await wait_for(matching_inputs, timeout, "next matching parameter and sample")
            for field in ("input", "multiplier", "offset"):
                if not isinstance(request.get(field), (int, float)) or isinstance(request.get(field), bool) or not math.isfinite(request[field]):
                    raise ValueError(f"parameter.{field} must be a finite number")
            if not isinstance(produced.get("value"), (int, float)) or isinstance(produced.get("value"), bool) or not math.isfinite(produced["value"]):
                raise ValueError("sample.value must be a finite number")
            output = {
                "runId": config["runId"],
                "token": config["token"],
                "round": current_round,
                "sequence": produced["sequence"],
                "formula": "sample*multiplier+offset",
                "input": request["input"],
                "sample": produced["value"],
                "value": produced["value"] * request["multiplier"] + request["offset"],
            }
            await result.set(output)
            await hub.flush(timeout=timeout)
            print(json.dumps({"event": f"done:{current_round}", "result": output}, separators=(",", ":")), flush=True)
            completed_round = current_round
        # Retain this process's RAM state until the harness has verified it in
        # Chromium. EOF is the graceful stop signal and also works over SSH.
        await asyncio.to_thread(sys.stdin.readline)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(json.dumps({"event": "error", "error": f"{type(error).__name__}: {error}"}), flush=True)
        raise SystemExit(1)
