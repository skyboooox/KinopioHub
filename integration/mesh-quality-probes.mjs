#!/usr/bin/env node

import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const GROUP = "239.77.0.1";
const PORTS = Object.freeze({ udp: 39001, http: 39002, tcp: 39003 });
const emit = event => process.stdout.write(`${JSON.stringify({ monoMs: performance.now(), ...event })}\n`);
function args() { const out = {}; for (let i = 3; i < process.argv.length; i += 2) { if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1]) throw Error("invalid probe arguments"); out[process.argv[i].slice(2)] = process.argv[i + 1]; } return out; }

export async function startProbeServer({ id, address }, output = emit) {
  if (!/^[abc]$/.test(id) || net.isIP(address) !== 4) throw Error("probe server requires id a/b/c and IPv4 address");
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (data, peer) => {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message?.schema !== "mesh-quality-probe/v1") return;
    output({ type: "probeReceipt", protocol: "udp", receiver: id, source: message.source, target: message.target, token: message.token, peer: peer.address });
    if (message.target === id) udp.send(Buffer.from(JSON.stringify({ token: message.token, receiver: id })), peer.port, peer.address);
  });
  await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(PORTS.udp, "0.0.0.0", () => { udp.off("error", reject); udp.addMembership(GROUP, address); resolve(); }); });
  const web = http.createServer((request, response) => { const token = request.headers["x-probe-token"]; output({ type: "probeReceipt", protocol: "http", receiver: id, source: request.headers["x-probe-source"], target: id, token }); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ receiver: id, token })); });
  await new Promise((resolve, reject) => { web.once("error", reject); web.listen(PORTS.http, address, resolve); });
  const tcp = net.createServer(socket => { let text = ""; socket.setEncoding("utf8"); socket.on("data", chunk => { text += chunk; if (!text.includes("\n")) return; let message; try { message = JSON.parse(text.split("\n")[0]); } catch { socket.destroy(); return; } output({ type: "probeReceipt", protocol: "tcp", receiver: id, source: message.source, target: id, token: message.token }); socket.end(`${JSON.stringify({ receiver: id, token: message.token })}\n`); }); });
  await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(PORTS.tcp, address, resolve); });
  output({ type: "probeReady", id, address, group: GROUP, ports: PORTS });
  return { close: async () => { udp.close(); await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => tcp.close(resolve))]); } };
}

export async function runProbe({ protocol, source, target, sourceAddress, targetAddress, timeoutMs = 1000 }) {
  if (!PORTS[protocol] || !/^[abc]$/.test(source) || !/^[abc]$/.test(target) || source === target || net.isIP(sourceAddress) !== 4 || net.isIP(targetAddress) !== 4) throw Error("invalid probe client arguments");
  const token = randomUUID(), started = performance.now();
  const bounded = setup => new Promise((resolve, reject) => {
    let cleanup = () => {}, settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); callback(value); };
    const timer = setTimeout(() => finish(reject, Error(`${protocol} probe timed out`)), timeoutMs);
    cleanup = setup(value => finish(resolve, value), error => finish(reject, error)) ?? cleanup;
  });
  let response;
  if (protocol === "udp") response = await bounded((resolve, reject) => {
    const socket = dgram.createSocket("udp4"); socket.once("error", reject); socket.on("message", data => { let value; try { value = JSON.parse(data); } catch { return; } if (value.token === token && value.receiver === target) resolve(value); });
    socket.bind(0, sourceAddress, () => { socket.setMulticastInterface(sourceAddress); socket.send(Buffer.from(JSON.stringify({ schema: "mesh-quality-probe/v1", source, target, token })), PORTS.udp, GROUP); });
    return () => socket.close();
  });
  if (protocol === "http") response = await bounded((resolve, reject) => {
    const request = http.get({ host: targetAddress, port: PORTS.http, path: "/probe", localAddress: sourceAddress, headers: { "x-probe-source": source, "x-probe-token": token } }, reply => { let text = ""; reply.setEncoding("utf8"); reply.on("data", chunk => text += chunk); reply.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); }); request.once("error", reject);
    return () => request.destroy();
  });
  if (protocol === "tcp") response = await bounded((resolve, reject) => {
    const socket = net.createConnection({ host: targetAddress, port: PORTS.tcp, localAddress: sourceAddress }); let text = ""; socket.setEncoding("utf8"); socket.once("error", reject); socket.on("connect", () => socket.write(`${JSON.stringify({ source, token })}\n`)); socket.on("data", chunk => text += chunk); socket.on("end", () => { try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); } });
    return () => socket.destroy();
  });
  if (response?.receiver !== target || response?.token !== token) throw Error("probe response identity mismatch");
  return { type: "probeResult", protocol, source, target, token, rttMs: performance.now() - started, response };
}

async function main() {
  const mode = process.argv[2], options = args();
  if (mode === "server") { const server = await startProbeServer(options); const stop = async () => { await server.close(); process.exit(0); }; process.once("SIGTERM", stop); process.once("SIGINT", stop); return; }
  if (mode === "client") { const result = await runProbe({ ...options, timeoutMs: Number(options.timeoutMs ?? 1000) }); emit(result); return; }
  throw Error("usage: mesh-quality-probes.mjs server|client --key value ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { emit({ type: "probeError", fatal: true, error: String(error?.message ?? error) }); process.exitCode = 1; });
