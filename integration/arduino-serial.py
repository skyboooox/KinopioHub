"""Test-only JSON-lines bridge. Requires pyserial; never prints credentials."""
import sys
import threading
import serial

port = serial.Serial()
port.port = sys.argv[1]
port.baudrate = 115200
port.timeout = 0.2
port.dtr = False
port.rts = False
port.open()


def receive():
    while port.is_open:
        try:
            line = port.readline()
            if line:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
        except serial.SerialException:
            return


threading.Thread(target=receive, daemon=True).start()
try:
    for line in sys.stdin.buffer:
        port.write(line)
        port.flush()
finally:
    port.close()
