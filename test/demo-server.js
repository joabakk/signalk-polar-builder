/**
 * demo-server.js
 *
 * Runs the real plugin against the mock Signal K app from the unit-test
 * harness (no Signal K server needed), serves public/ the way a server
 * would, and feeds it a moving boat - a seeded polar table, live wind and
 * speed over a minimal WebSocket, and the standard readonly API for the MFD
 * tile. Used to try the webapp locally and to take its screenshots.
 *
 * Usage:
 *   node test/demo-server.js            # http://localhost:3939/
 *   PORT=4000 node test/demo-server.js
 *   open http://localhost:3939/mfd/     # the MFD tile
 */

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { createHarness, kt, rad } = require('./helpers/harness')

const PORT = Number(process.env.PORT) || 3939
const PUBLIC = path.join(__dirname, '..', 'public')
const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' }

// ---- demo polar: a plausible 38 ft cruiser, TWA rows x TWS columns --------

const TWS = [4, 6, 8, 10, 12, 14, 16, 20]
const SHAPE = { 32: 0.6, 36: 0.72, 40: 0.8, 45: 0.86, 52: 0.92, 60: 0.96, 75: 1.0, 90: 1.02, 100: 1.03, 110: 1.02, 120: 0.98, 135: 0.9, 150: 0.8, 165: 0.72, 180: 0.66 }

function polarCsv (scale) {
  const lines = ['TWA\\TWS,' + TWS.join(',')]
  Object.keys(SHAPE).forEach((twa) => {
    const row = TWS.map((tws) => Math.round(6.9 * (1 - Math.exp(-tws / 7.5)) * SHAPE[twa] * scale * 100) / 100)
    lines.push([twa].concat(row).join(','))
  })
  return lines.join('\n')
}

async function seed (h) {
  await h.post('/profiles', { name: 'Main + J1' })
  await h.importCsv(polarCsv(1.0))
  await h.post('/profiles/main-j1/sail-config', { sailConfig: 'J1+Main' })
  await h.post('/profiles', { name: 'Main + Code 0' })
  await h.importCsv(polarCsv(1.06))
  await h.post('/profiles/main-code-0/sail-config', { sailConfig: 'Code0+Main' })
  await h.post('/profiles/main-j1/activate')
  await h.del('/profiles/default')
}

// ---- minimal WebSocket (text frames, server -> client only) ---------------

const sockets = new Set()

function wsFrame (text) {
  const payload = Buffer.from(text)
  const n = payload.length
  const header = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255])
  return Buffer.concat([header, payload])
}

function broadcast (delta) {
  const frame = wsFrame(JSON.stringify(delta))
  sockets.forEach((s) => s.write(frame))
}

// ---- main -----------------------------------------------------------------

async function main () {
  const h = createHarness()
  h.start({ enableMfdDisplay: true, autoSwitchBySailConfig: true, useSignedTwa: false })
  await seed(h)

  let tick = 0
  function liveValues () {
    tick += 1
    const tws = 11.6 + 0.7 * Math.sin(tick / 7)
    const twa = 41.5 + 1.2 * Math.sin(tick / 5)
    const bsp = 4.35 + 0.08 * Math.sin(tick / 3)
    return {
      'environment.wind.speedTrue': kt(tws),
      'environment.wind.angleTrueWater': rad(twa),
      'navigation.speedThroughWater': kt(bsp),
      'navigation.rateOfTurn': rad(0.4 * Math.sin(tick / 4)),
      'navigation.headingTrue': rad(212),
      'navigation.attitude': { roll: rad(-14), pitch: rad(2), yaw: rad(212) },
      'propulsion.main.state': 'stopped',
      'sails.inventory.main.active': true,
      'sails.inventory.main.name': 'Main',
      'sails.inventory.j1.active': true,
      'sails.inventory.j1.name': 'J1'
    }
  }
  setInterval(() => {
    const values = liveValues()
    Object.keys(values).forEach((p) => h.emit(p, values[p]))
    broadcast({ context: 'vessels.self', updates: [{ values: Object.keys(values).map((p) => ({ path: p, value: values[p] })) }] })
  }, 1000)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/plugins/polar-builder/')) {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString()
        const sub = url.pathname.replace('/plugins/polar-builder', '') + url.search
        const opts = sub.startsWith('/polar/import') ? { raw } : { body: raw ? JSON.parse(raw) : {} }
        const out = await h.call(req.method, sub, opts)
        res.writeHead(out.status, { 'content-type': out.headers['content-type'] || 'application/json', ...(out.headers['content-disposition'] ? { 'content-disposition': out.headers['content-disposition'] } : {}) })
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
      })
      return
    }

    if (url.pathname === '/signalk/v1/api/vessels/self/performance/') {
      const group = {}
      Object.keys(h.published).forEach((p) => { group[p.replace('performance.', '')] = { value: h.published[p] } })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(group))
      return
    }

    let file = path.join(PUBLIC, decodeURIComponent(url.pathname))
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    socket.on('data', () => {})
  })

  server.listen(PORT, () => console.log(`Polar Builder demo on http://localhost:${PORT}/ (MFD tile: /mfd/)`))
  process.on('SIGINT', () => { h.stop(); process.exit(0) })
  process.on('SIGTERM', () => { h.stop(); process.exit(0) })
}

main()
