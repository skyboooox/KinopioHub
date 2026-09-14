"""Real NATS Core live-command semantic probes; no SDK or clock mocks.

Run with the workspace Python SDK environment and PYTHONPATH pointing at its src.
Raw output directories are exclusive: failed attempts are never overwritten.
"""
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import platform
import time
import traceback
import uuid
from pathlib import Path

from kinopio_hub import KinopioHub
from kinopio_hub import _protocol as protocol
from kinopio_hub._broker import (
    BROKER_VERSION,
    ensure_managed_broker,
    start_managed_broker,
)

PLAN = {
    'schema': 1, 'blocks_per_scenario': 5,
    'scenarios': ['equal_values_context', 'receiver_downlink_expiry', 'receiver_restart', 'broker_restart'],
    'lease_ms': 500, 'restart_lease_ms': 1500, 'hold_seconds': .8,
    'quiet_seconds': .2, 'send_timeout': 1, 'event_timeout': 4,
    'criteria': {
        'equal_values_context': 'Both identical payload sends succeed and invoke callbacks; delayed application rechecks context after expiry and skips execution.',
        'receiver_downlink_expiry': 'Warm lease, block only receiver downlink, send succeeds with no callback while held; native NATS observer sees data after release but live callback drops it; fresh send recovers.',
        'receiver_restart': 'Close/recreate receiver hub while sender connection persists; cached old session send succeeds but no new receiver callback; after old TTL a new send renews session and is received.',
        'broker_restart': 'After actual broker exit both hubs detect disconnect; offline send rejects; same-port fresh broker causes new receiver session, no replay during quiet window, new send is received.'},
    'limits': ['One host and one asyncio process for SDK instances; independent real broker per block.',
               'Finite quiet windows establish bounded absence only; no execution acknowledgment or performance comparison.',
               'Gate preserves FIFO bytes, does not parse NATS, and delays all receiver downlink traffic.'],
}


class Gate:
    """Transparent FIFO TCP gate; only server-to-client bytes can be held."""
    def __init__(self, port, emit):
        self.port, self.emit = port, emit
        self.open = asyncio.Event()
        self.open.set()
        self.tasks, self.writers = set(), set()
        self.held_bytes = 0

    async def start(self):
        self.server = await asyncio.start_server(self.accept, '127.0.0.1', 0)
        return f'nats://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'

    async def accept(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.writers.add(writer)
        upstream = None
        pumps = []
        try:
            remote, upstream = await asyncio.open_connection('127.0.0.1', self.port)
            self.writers.add(upstream)
            async def pump(source, target, downlink):
                while data := await source.read(65536):
                    if downlink:
                        if not self.open.is_set():
                            self.held_bytes += len(data)
                            self.emit('gate_held', bytes=len(data))
                        await self.open.wait()
                    target.write(data)
                    await target.drain()
            pumps = [asyncio.create_task(pump(reader, upstream, False)), asyncio.create_task(pump(remote, writer, True))]
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except OSError as error:
            self.emit('gate_connection_error', error=str(error))
        finally:
            for item in pumps:
                item.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
            for item in (writer, upstream):
                if item:
                    item.close()
                    try:
                        await item.wait_closed()
                    except OSError:
                        pass
                    self.writers.discard(item)
            self.tasks.discard(task)

    async def close(self):
        self.open.set()
        self.server.close()
        await self.server.wait_closed()
        tasks = list(self.tasks)
        for writer in list(self.writers):
            writer.close()
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
        self.tasks.difference_update(tasks)


async def until(predicate, timeout=4):
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= end:
            raise TimeoutError('Evidence predicate timed out')
        await asyncio.sleep(.005)


async def block(scenario, index, output, binary, run_id):
    block_id = f'{scenario}-{index}-{uuid.uuid4().hex}'
    log = (output / f'{block_id}.jsonl').open('x')
    def emit(event, **fields):
        log.write(json.dumps(dict(fields, run_id=run_id, block_id=block_id, process_id=os.getpid(),
                                  monotonic_ns=time.monotonic_ns(), event=event)) + '\n')
        log.flush()
    hubs, brokers, gate = [], [], None
    callbacks, wire, actions = [], [], []
    result = {'scenario': scenario, 'block': index, 'block_id': block_id, 'passed': False}
    try:
        broker = await start_managed_broker(binary=binary, host='127.0.0.1')
        brokers.append(broker)
        emit('broker_started', broker_pid=broker.pid, port=broker.port)
        gate = Gate(broker.port, emit)
        receiver_url = await gate.start()
        def hub(url):
            value = KinopioHub(block_id, mesh=False, discovery=False, servers=url,
                               probe_interval=.05, timeout=2, peer_timeout=.01)
            hubs.append(value)
            return value
        sender, receiver = hub(broker.url), hub(receiver_url)
        await asyncio.gather(sender.connected(4), receiver.connected(4))
        ttl = PLAN['restart_lease_ms'] if scenario == 'receiver_restart' else PLAN['lease_ms']
        channel = sender.live('command')
        def callback(value, context):
            callbacks.append(value)
            emit('callback', value=value, context_valid=context.is_valid(), expires_at=context.expires_at)
            if scenario == 'equal_values_context':
                async def apply():
                    await asyncio.sleep(PLAN['hold_seconds'])
                    valid = context.is_valid()
                    actions.append(valid)
                    emit('application_attempt', value=value, context_valid=valid, executed=valid)
                actions_tasks.append(asyncio.create_task(apply()))
        actions_tasks = []
        async def bind(value):
            await value.live('command').subscribe(callback, max_age_ms=ttl, with_context=True)
            async def observed(message):
                data = json.loads(message.data)
                wire.append(data['value'])
                emit('native_nats_data', value=data['value'], session=data['session'], seq=data['seq'])
            await value.connection.active['connection'].subscribe(channel.subject + '.data', cb=observed)
            await value.connection.active['connection'].flush()
            emit('receiver_bound', instance_id=value.instance_id, session=value.live('command').receivers[0].session)
        await bind(receiver)
        candidate = sender.connection.active
        emit('sender_connected', instance_id=sender.instance_id)
        async def send(value):
            request_id = uuid.uuid4().hex
            emit('send_begin', request_id=request_id, value=value)
            try:
                await channel.send(value, timeout=PLAN['send_timeout'])
                emit('send_end', request_id=request_id, outcome='success',
                     lease={k: v for k, v in channel.grant.items() if k != 'candidate'})
                return 'success'
            except Exception as error:  # noqa: BLE001 - Preserve every failed experimental attempt.
                code = getattr(error, 'code', type(error).__name__)
                emit('send_end', request_id=request_id, outcome=code, error=str(error))
                return code
        assert await send({'command': 'warm'}) == 'success'
        await until(lambda: len(callbacks) == 1 and len(wire) == 1)
        old_session = receiver.live('command').receivers[0].session
        old_expiry = channel.grant['expiry']
        if scenario == 'equal_values_context':
            assert await send({'command': 'warm'}) == 'success'
            await until(lambda: len(callbacks) == 2)
            await asyncio.gather(*actions_tasks)
            assert actions == [False, False]
        elif scenario == 'receiver_downlink_expiry':
            gate.open.clear()
            emit('gate_closed')
            assert await send({'command': 'held'}) == 'success'
            await until(lambda: gate.held_bytes > 0)
            assert len(callbacks) == 1
            await asyncio.sleep(PLAN['hold_seconds'])
            gate.open.set()
            emit('gate_released', held_bytes=gate.held_bytes)
            await until(lambda: {'command': 'held'} in wire)
            await asyncio.sleep(PLAN['quiet_seconds'])
            assert callbacks == [{'command': 'warm'}]
            assert sender.connection.active is candidate
            assert await send({'command': 'recovered'}) == 'success'
            await until(lambda: len(callbacks) == 2)
        elif scenario == 'receiver_restart':
            await receiver.close()
            emit('receiver_closed', instance_id=receiver.instance_id)
            receiver = hub(receiver_url)
            await receiver.connected(4)
            await bind(receiver)
            assert receiver.live('command').receivers[0].session != old_session
            assert sender.connection.active is candidate
            assert time.monotonic() + .05 < old_expiry, 'Restart exceeded cached lease test window'
            assert await send({'command': 'old-session'}) == 'success'
            assert channel.grant['session'] == old_session
            await until(lambda: {'command': 'old-session'} in wire)
            await asyncio.sleep(PLAN['quiet_seconds'])
            assert callbacks == [{'command': 'warm'}]
            await asyncio.sleep(max(0, old_expiry - time.monotonic()) + .05)
            assert await send({'command': 'new-session'}) == 'success'
            await until(lambda: len(callbacks) == 2)
            assert channel.grant['session'] != old_session
        else:
            await broker.close()
            emit('broker_stopped', broker_pid=broker.pid)
            await until(lambda: all(item.connection.active is None for item in hubs))
            assert await send({'command': 'offline'}) == 'DISCONNECTED'
            replacement = await start_managed_broker(binary=binary, host='127.0.0.1', port=broker.port)
            brokers.append(replacement)
            emit('broker_started', broker_pid=replacement.pid, port=replacement.port)
            await asyncio.gather(sender.connected(4), receiver.connected(4))
            assert receiver.live('command').receivers[0].session != old_session
            await asyncio.sleep(PLAN['quiet_seconds'])
            assert callbacks == [{'command': 'warm'}]
            assert await send({'command': 'reconnected'}) == 'success'
            await until(lambda: len(callbacks) == 2)
        assert not sender.store.records and not receiver.store.records
        result.update(passed=True, callbacks=callbacks, wire=wire, actions=actions)
        emit('criteria_passed', **result)
    except Exception as error:  # noqa: BLE001 - Preserve every failed experimental attempt.
        result.update(error_type=type(error).__name__, error=str(error))
        emit('block_failure', traceback=traceback.format_exc(), **result)
    finally:
        await asyncio.gather(*(value.close() for value in hubs))
        if gate:
            await gate.close()
        await asyncio.gather(*(value.close() for value in brokers))
        alive = []
        for value in brokers:
            try:
                os.kill(value.pid, 0)
                alive.append(value.pid)
            except ProcessLookupError:
                pass
        emit('cleanup', broker_pids_alive=alive, hubs_closed=all(value.closed for value in hubs),
             gate_tasks_remaining=len(gate.tasks) if gate else 0)
        result['cleanup_passed'] = not alive and all(value.closed for value in hubs) and (not gate or not gate.tasks)
        log.close()
    return result


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    run_id = uuid.uuid4().hex
    plan = dict(PLAN, run_id=run_id)
    (args.output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    binary = await ensure_managed_broker(cache_dir=args.cache_dir)
    source = Path(protocol.__file__).parent
    hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(source.glob('*.py'))}
    hashes[str(Path(__file__).resolve())] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    hashes[str(binary)] = hashlib.sha256(binary.read_bytes()).hexdigest()
    metadata = {'run_id': run_id, 'pid': os.getpid(), 'python': platform.python_version(),
                    'sdk_version': protocol.VERSION, 'nats_py': importlib.metadata.version('nats-py'),
                    'broker_version': BROKER_VERSION, 'source_hashes': hashes,
                    'protocol_revision': getattr(protocol, 'PROTOCOL', None)}
    (args.output / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    results = []
    for scenario in PLAN['scenarios']:
        for index in range(PLAN['blocks_per_scenario']):
            result = await block(scenario, index, args.output, binary, run_id)
            results.append(result)
            print(json.dumps(result), flush=True)
    summary = {'run_id': run_id, 'results': results, 'all_passed': all(r['passed'] and r['cleanup_passed'] for r in results)}
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if not summary['all_passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
