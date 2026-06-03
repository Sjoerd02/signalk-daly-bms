'use strict'

const { SerialPort } = require('serialport')

module.exports = function (app) {
  let port = null
  let pollTimer = null
  let rxBuffer = Buffer.alloc(0)
  let cellCount = 0
  let tempCount = 0

  const plugin = {
    id: 'signalk-daly-bms',
    name: 'Daly BMS (RS485)',
    description: 'Reads Daly Smart BMS data via RS485 serial port',

    schema: {
      type: 'object',
      required: ['serialPort'],
      properties: {
        serialPort: {
          type: 'string',
          title: 'Serial port',
          description: 'e.g. /dev/ttyUSB0',
          default: '/dev/ttyUSB0'
        },
        baudRate: {
          type: 'number',
          title: 'Baud rate',
          default: 9600
        },
        pollInterval: {
          type: 'number',
          title: 'Poll interval (seconds)',
          default: 5,
          minimum: 1
        },
        batteryInstance: {
          type: 'string',
          title: 'Battery instance (used in SignalK path)',
          description: 'electrical.batteries.<instance>.*',
          default: 'house'
        }
      }
    },

    start (options) {
      const cfg = {
        path:     options.serialPort      || '/dev/ttyUSB0',
        baudRate: options.baudRate        || 9600,
        interval: (options.pollInterval   || 5) * 1000,
        instance: options.batteryInstance || 'house'
      }

      port = new SerialPort({ path: cfg.path, baudRate: cfg.baudRate, autoOpen: false })

      port.on('data', chunk => {
        rxBuffer = Buffer.concat([rxBuffer, chunk])
        parseBuffer(cfg.instance)
      })

      port.on('error', err => app.error(`[daly-bms] ${err.message}`))

      port.open(err => {
        if (err) {
          app.error(`[daly-bms] Cannot open ${cfg.path}: ${err.message}`)
          return
        }
        app.debug(`[daly-bms] Connected on ${cfg.path}`)
        doPoll(cfg)
        pollTimer = setInterval(() => doPoll(cfg), cfg.interval)
      })
    },

    stop () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      if (port && port.isOpen) port.close()
      rxBuffer = Buffer.alloc(0)
      cellCount = 0
      tempCount = 0
    }
  }

  // ── Protocol helpers ──────────────────────────────────────────────────────

  function checksum (buf) {
    return buf.reduce((s, b) => s + b, 0) & 0xFF
  }

  function buildRequest (cmd) {
    const f = Buffer.from([0xA5, 0x40, cmd, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    f[12] = checksum(f.slice(0, 12))
    return f
  }

  // Correct command order: status first so cellCount/tempCount are known
  // before cell-voltage and temperature responses arrive.
  // 400 ms spacing handles longer cables with higher latency.
  const POLL_CMDS = [0x94, 0x90, 0x95, 0x96, 0x98]

  function doPoll (cfg) {
    if (!port || !port.isOpen) return
    POLL_CMDS.forEach((cmd, i) => {
      setTimeout(() => {
        if (port && port.isOpen) port.write(buildRequest(cmd))
      }, i * 400)
    })
  }

  // ── Frame parser ──────────────────────────────────────────────────────────

  function parseBuffer (instance) {
    while (rxBuffer.length >= 13) {
      const start = rxBuffer.indexOf(0xA5)
      if (start < 0) { rxBuffer = Buffer.alloc(0); return }
      if (start > 0)  { rxBuffer = rxBuffer.slice(start) }

      const dataLen  = rxBuffer[3]
      const frameLen = 4 + dataLen + 1
      if (rxBuffer.length < frameLen) return

      const frame = rxBuffer.slice(0, frameLen)
      rxBuffer = rxBuffer.slice(frameLen)

      if (checksum(frame.slice(0, frameLen - 1)) !== frame[frameLen - 1]) {
        app.debug('[daly-bms] checksum error, frame dropped')
        continue
      }

      handleFrame(frame, instance)
    }
  }

  function handleFrame (frame, instance) {
    const cmd  = frame[2]
    const data = frame.slice(4, 4 + frame[3])

    switch (cmd) {
      case 0x90: parse90(data, instance); break  // SOC, voltage, current
      case 0x94: parse94(data);           break  // status: cell count, cycles
      case 0x95: parse95(data, instance); break  // cell voltages
      case 0x96: parse96(data, instance); break  // temperatures
      case 0x98: parse98(data, instance); break  // faults/alarms
    }
  }

  // ── Command parsers ───────────────────────────────────────────────────────

  // 0x90 – SOC, total voltage, current
  // data: [volt_H volt_L] [acq_H acq_L] [curr_H curr_L] [soc_H soc_L]
  function parse90 (d, instance) {
    const voltage = d.readUInt16BE(0) / 10          // 0.1 V
    const current = (d.readUInt16BE(4) - 30000) / 10 // offset 30000, 0.1 A
    const soc     = d.readUInt16BE(6) / 1000         // 0.1 % → 0-1 ratio

    publish(instance, [
      { path: batPath(instance, 'voltage'),        value: voltage },
      { path: batPath(instance, 'current'),        value: current },
      { path: batPath(instance, 'capacity.stateOfCharge'), value: soc }
    ])
  }

  // 0x94 – Status
  // data: [cells] [temp_sensors] [charger] [load] [states] [cycles_H cycles_L] [pad]
  function parse94 (d) {
    cellCount = d[0]
    tempCount = d[1]
    // cycles = d.readInt16BE(5) — available if needed later
  }

  // 0x95 – Cell voltages (multiple frames for >3 cells)
  // data: [frame_idx] [v1_H v1_L] [v2_H v2_L] [v3_H v3_L] [pad]
  function parse95 (d, instance) {
    const groupIdx = d[0]   // 1-based frame index
    const values   = []

    for (let i = 0; i < 3; i++) {
      const cellNum = (groupIdx - 1) * 3 + i + 1
      if (cellCount > 0 && cellNum > cellCount) break
      const mv = d.readUInt16BE(1 + i * 2)
      if (mv > 0) {
        values.push({ path: batPath(instance, `cells.${cellNum}.voltage`), value: mv / 1000 })
      }
    }

    if (values.length) publish(instance, values)
  }

  // 0x96 – Temperatures (up to 7 sensors per frame)
  // data: [frame_idx] [t1] [t2] ... [t7]  — temp °C = byte - 40
  function parse96 (d, instance) {
    const values = []
    const count  = tempCount || 1   // fallback to 1 if status not yet received

    for (let i = 0; i < count; i++) {
      const tempC = d[1 + i] - 40
      const tempK = tempC + 273.15   // SignalK uses Kelvin
      values.push({ path: batPath(instance, 'temperature'), value: tempK })
    }

    if (values.length) publish(instance, values)
  }

  // 0x98 – Fault flags (8 bytes, any non-zero = alarm)
  function parse98 (d, instance) {
    const alarm = d.some(b => b !== 0)
    publish(instance, [{ path: batPath(instance, 'alarm'), value: alarm }])
  }

  // ── SignalK helpers ───────────────────────────────────────────────────────

  function batPath (instance, key) {
    return `electrical.batteries.${instance}.${key}`
  }

  function publish (instance, values) {
    app.handleMessage(plugin.id, {
      updates: [{ source: { label: plugin.id }, values }]
    })
  }

  return plugin
}
