# signalk-daly-bms

A [SignalK](https://signalk.org) plugin that reads data from a **Daly Smart BMS** via RS485 serial connection and publishes it to the SignalK data model.

## Features

- Total voltage, current and state of charge (SOC)
- Individual cell voltages (4S, 8S, 16S — auto-detected)
- Battery temperature
- Fault/alarm flag
- Configurable serial port, poll interval and battery instance name
- Works with any USB-to-RS485 adapter

## Hardware requirements

- Daly Smart BMS with RS485 port (all cell configurations supported)
- USB-to-RS485 adapter connected to the SignalK host (e.g. Raspberry Pi)
- RS485 cable wired to the BMS: connect **A**, **B** and **GND**

## Installation

### From the SignalK app store

Search for **signalk-daly-bms** in the SignalK server app store and click Install.

### Manual

```bash
cd ~/.signalk
npm install signalk-daly-bms
```

Restart the SignalK server after installation.

## Configuration

Open the SignalK server web UI → **Server → Plugin Config → Daly BMS (RS485)**.

| Setting | Default | Description |
|---|---|---|
| Serial port | `/dev/ttyUSB0` | Serial device of the RS485 adapter |
| Baud rate | `9600` | Must match BMS setting (9600 is standard) |
| Poll interval | `5` | Seconds between data requests |
| Battery instance | `house` | Instance name used in the SignalK path |

On Linux the port is typically `/dev/ttyUSB0` or `/dev/ttyUSB1`.  
On Windows use `COM3`, `COM4` etc.

The `pi` user may need to be added to the `dialout` group for serial port access:

```bash
sudo usermod -a -G dialout pi
```

## SignalK paths

All values are published under `electrical.batteries.<instance>.*`:

| Path | Unit | Description |
|---|---|---|
| `electrical.batteries.house.voltage` | V | Total pack voltage |
| `electrical.batteries.house.current` | A | Current (negative = discharging) |
| `electrical.batteries.house.capacity.stateOfCharge` | ratio | State of charge (0–1) |
| `electrical.batteries.house.temperature` | K | Battery temperature |
| `electrical.batteries.house.cells.1.voltage` | V | Cell 1 voltage |
| `electrical.batteries.house.cells.N.voltage` | V | Cell N voltage (N = 1 … cell count) |
| `electrical.batteries.house.alarm` | boolean | True if any fault flag is set |

Cell count is read automatically from the BMS on startup.

## Compatibility

Tested on:
- Daly Smart BMS 4S 12V 500A

Should work with any Daly Smart BMS that supports the standard RS485 protocol (all cell counts).

## License

MIT
