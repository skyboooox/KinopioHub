import assert from "node:assert/strict";
import test from "node:test";
import { runProbe, startProbeServer } from "./mesh-quality-probes.mjs";

test("probe server returns same-clock multicast UDP, HTTP, and TCP round trips with receipt identity", async () => {
  const receipts = [], server = await startProbeServer({ id: "b", address: "127.0.0.1" }, event => receipts.push(event));
  try {
    for (const protocol of ["udp", "http", "tcp"]) {
      const result = await runProbe({ protocol, source: "a", target: "b", sourceAddress: "127.0.0.1", targetAddress: "127.0.0.1" });
      assert.equal(result.response.receiver, "b"); assert.ok(result.rttMs >= 0);
    }
    assert.deepEqual(receipts.filter(event => event.type === "probeReceipt").map(event => event.protocol), ["udp", "http", "tcp"]);
  } finally { await server.close(); }
});
