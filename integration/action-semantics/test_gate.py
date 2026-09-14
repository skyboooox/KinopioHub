"""Validate FIFO hold/release independently of KinopioHub semantics."""
import asyncio
import unittest

from kinopio_hub._compat import timeout
from probe import Gate


class GateTest(unittest.IsolatedAsyncioTestCase):
    async def test_receiver_downlink_hold_keeps_upstream_and_fifo(self):
        received = bytearray()
        events = []

        async def echo(reader, writer):
            try:
                while data := await reader.read(65536):
                    received.extend(data)
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(echo, '127.0.0.1', 0)
        gate = Gate(server.sockets[0].getsockname()[1], lambda event, **fields: events.append((event, fields)))
        writer = None
        try:
            url = await gate.start()
            reader, writer = await asyncio.open_connection('127.0.0.1', int(url.rsplit(':', 1)[1]))
            writer.write(b'warm')
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.readexactly(4), 1), b'warm')
            gate.open.clear()
            payload = bytes(range(256)) * 1024
            writer.write(payload)
            await writer.drain()
            async with timeout(2):
                while len(received) < len(payload) + 4:
                    await asyncio.sleep(.005)
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(reader.read(1), .03)
            self.assertGreater(gate.held_bytes, 0)
            gate.open.set()
            self.assertEqual(await asyncio.wait_for(reader.readexactly(len(payload)), 2), payload)
        finally:
            if writer:
                writer.close()
                await writer.wait_closed()
            await gate.close()
            server.close()
            await server.wait_closed()
        self.assertFalse(gate.tasks)
        self.assertFalse(gate.writers)
        self.assertTrue(events)


if __name__ == '__main__':
    unittest.main()
