import sys
import time
import csv
import threading
import json
from datetime import datetime

# Real Hardware Libraries
try:
    import can
    from can.interfaces.ixxat import IXXATBus
    HAS_CAN = True
except ImportError:
    HAS_CAN = False

class CANInterface:
    """Handles communication with IXXAT USB-to-CAN V2"""
    def __init__(self, channel=0, bitrate=125000):
        self.channel = channel
        self.bitrate = bitrate
        self.bus = None
        self.is_connected = False
        self.running = False
        
    def connect(self):
        if not HAS_CAN:
            print("Error: 'python-can' or IXXAT drivers not found.")
            return False
        try:
            # Configure IXXAT Interface
            self.bus = can.interface.Bus(
                interface='ixxat', 
                channel=self.channel, 
                bitrate=self.bitrate,
                extended=True
            )
            self.is_connected = True
            self.running = True
            print(f"Connected to IXXAT Channel {self.channel} at {self.bitrate}bps")
            return True
        except Exception as e:
            print(f"Connection failed: {e}")
            return False

    def receive_loop(self, callback):
        """Continuous reception loop"""
        while self.running:
            try:
                msg = self.bus.recv(timeout=1.0)
                if msg:
                    callback(msg)
            except Exception as e:
                print(f"RX Error: {e}")
                time.sleep(1)

    def send_command(self, can_id, data):
        if self.is_connected:
            msg = can.Message(
                arbitration_id=can_id, 
                data=data, 
                is_extended_id=True
            )
            try:
                self.bus.send(msg)
                print(f"TX: {hex(can_id)} -> {data.hex(' ')}")
            except Exception as e:
                print(f"TX Error: {e}")

class CANDecoder:
    """Decodes raw CAN frames into charger parameters based on SMR protocol"""
    
    @staticmethod
    def decode(msg):
        can_id = msg.arbitration_id
        data = msg.data
        
        # ID: 28F3FF0 (Module Status)
        if can_id == 0x28F3FF0:
            voltage = (data[0] << 8 | data[1]) * 0.1
            current = (data[2] << 8 | data[3]) * 0.1
            input_v = (data[4] << 8 | data[5]) * 0.1
            temp = data[6] - 40
            return {
                'type': 'STATUS',
                'voltage': voltage,
                'current': current,
                'power': (voltage * current) / 1000.0,
                'temp': temp,
                'state': 'CHARGING' if data[7] > 0 else 'STANDBY'
            }
            
        # ID: 28E01F0 (Secondary Monitor)
        elif can_id == 0x28E01F0:
            voltage = (data[0] << 8 | data[1]) * 0.1
            current = (data[4] << 8 | data[5]) * 0.01
            return {
                'type': 'MONITOR',
                'voltage': voltage,
                'current': current,
                'temp': data[6] - 40,
                'fan': data[7] * 50
            }
            
        return None

class Logger:
    """Saves decoded data and raw frames to CSV"""
    def __init__(self, filename=None):
        if not filename:
            filename = f"voltcan_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        self.filename = filename
        self.file = open(self.filename, 'w', newline='')
        self.writer = csv.writer(self.file)
        self.writer.writerow(['Timestamp', 'ID', 'Data', 'Voltage', 'Current', 'Temp'])

    def log(self, msg, decoded=None):
        ts = datetime.now().isoformat()
        row = [ts, hex(msg.arbitration_id), msg.data.hex(' ')]
        if decoded:
            row.extend([decoded.get('voltage', ''), decoded.get('current', ''), decoded.get('temp', '')])
        self.writer.writerow(row)
        self.file.flush()

# --- Main Application Logic ---
# This script would be run on the local machine connected to the IXXAT hardware.
# It can be extended with a WebSocket server to pipe data to the React frontend.

if __name__ == "__main__":
    interface = CANInterface(channel=0, bitrate=125000)
    decoder = CANDecoder()
    logger = Logger()

    def on_message_received(msg):
        decoded = decoder.decode(msg)
        logger.log(msg, decoded)
        
        if decoded:
            print(f"[{hex(msg.arbitration_id)}] V: {decoded.get('voltage')}V | I: {decoded.get('current')}A | T: {decoded.get('temp')}C")
        else:
            print(f"[{hex(msg.arbitration_id)}] RAW: {msg.data.hex(' ')}")

    if interface.connect():
        try:
            while True:
                cmd = input("\nVoltCAN Control [s: start, x: stop, q: quit]: ").lower()
                if cmd == 's':
                    if not interface.running:
                        interface.running = True
                        rx_thread = threading.Thread(target=interface.receive_loop, args=(on_message_received,), daemon=True)
                        rx_thread.start()
                        print(">>> Communication STARTED")
                    else:
                        print(">>> Already running")
                elif cmd == 'x':
                    interface.running = False
                    print(">>> Communication STOPPED")
                elif cmd == 'q':
                    interface.running = False
                    print(">>> Exiting...")
                    break
                else:
                    print(">>> Invalid command")
        except KeyboardInterrupt:
            print("\nStopping...")
            interface.running = False
    else:
        print("Could not initialize CAN interface. Check hardware and drivers.")
