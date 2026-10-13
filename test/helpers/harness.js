/**
 * Test harness: runs the real plugin (index.js) against a mock Signal K
 * `app` and a tiny express-like router, so behaviour can be tested - and
 * demoed, see test/demo-server.js - without a Signal K server.
 *
 * Only the parts of the server API the plugin actually uses are mocked:
 * app.subscriptionmanager.subscribe, app.handleMessage, app.getDataDirPath,
 * app.setPluginStatus, app.debug/error, and router get/post/delete.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

function createRouter () {
  const routes = []
  const add = (method) => (pattern, handler) => {
    const keys = []
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key)
      return '([^/]+)'
    })
    routes.push({ method, re: new RegExp('^' + source + '$'), keys, handler })
  }
  return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT') }
}

// Runs a route handler like express would. `body` is the parsed JSON body
// (req.body); `raw` is streamed to the handler via req.on('data'/'end'), as
// the CSV import route reads it.
function callRoute (router, method, url, { body, raw } = {}) {
  const parsed = new URL(url, 'http://localhost')
  const route = router.routes.find((r) => r.method === method && r.re.test(parsed.pathname))
  if (!route) return Promise.resolve({ status: 404, headers: {}, body: null })

  const match = route.re.exec(parsed.pathname)
  const params = {}
  route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]) })

  const req = new EventEmitter()
  req.params = params
  req.query = Object.fromEntries(parsed.searchParams)
  req.body = body

  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      status (code) { this.statusCode = code; return this },
      set (key, value) { this.headers[key.toLowerCase()] = value; return this },
      type (value) { this.headers['content-type'] = value; return this },
      json (obj) {
        this.headers['content-type'] = 'application/json'
        resolve({ status: this.statusCode, headers: this.headers, body: obj })
      },
      send (text) { resolve({ status: this.statusCode, headers: this.headers, body: text }) }
    }
    route.handler(req, res)
    if (raw !== undefined) {
      setImmediate(() => {
        req.emit('data', raw)
        req.emit('end')
      })
    }
  })
}

function createHarness ({ dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'polar-builder-test-'))
  const published = {}
  let deltaCallback = null

  const app = {
    status: '',
    debug () {},
    error () {},
    setPluginStatus (s) { app.status = s },
    getDataDirPath () { return dir },
    handleMessage (pluginId, delta) {
      delta.updates.forEach((u) => u.values.forEach((v) => { published[v.path] = v.value }))
    },
    subscriptionmanager: {
      subscribe (subscription, unsubscribes, errorCallback, callback) {
        app.subscription = subscription
        deltaCallback = callback
        unsubscribes.push(() => { deltaCallback = null })
      }
    }
  }

  const plugin = require('../../index.js')(app)
  const router = createRouter()
  plugin.registerWithRouter(router)

  return {
    app,
    plugin,
    router,
    published,
    dir,
    start (options) { plugin.start(options || {}) },
    emit (pathName, value) {
      deltaCallback({ updates: [{ values: [{ path: pathName, value }] }] })
    },
    clearPublished () { Object.keys(published).forEach((k) => delete published[k]) },
    call: (method, url, opts) => callRoute(router, method, url, opts),
    get: (url) => callRoute(router, 'GET', url),
    post: (url, body) => callRoute(router, 'POST', url, { body }),
    del: (url) => callRoute(router, 'DELETE', url),
    importCsv: (csv, query) => callRoute(router, 'POST', '/polar/import' + (query || ''), { raw: csv }),
    stop () {
      plugin.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

// Fake clock for node:test: the plugin's timers and Date.now() both run on
// it, so a "40 second" scenario takes microseconds. Call before createHarness.
function useClock (t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1700000000000 })
}

// Emits `values` ({path: value}) once per simulated second for `seconds`.
function feed (t, h, seconds, values) {
  for (let i = 0; i < seconds; i++) {
    Object.keys(values).forEach((p) => h.emit(p, values[p]))
    t.mock.timers.tick(1000)
  }
}

const KT = 1.9438444924574
const kt = (knots) => knots / KT
const rad = (deg) => (deg * Math.PI) / 180

// A plausible cruiser polar (TWA rows x TWS 8/12/16 columns), values at
// most 2 decimals since the matrix/CSV output rounds to 2 dp. The 12 kt
// column is the base table; the others are scaled copies.
const BASE_12 = { 35: 5.0, 40: 5.6, 50: 6.2, 60: 6.7, 90: 7.4, 120: 7.0, 140: 6.8, 150: 6.2, 165: 5.5, 180: 4.9 }
function sampleCsv () {
  const r2 = (x) => Math.round(x * 100) / 100
  const lines = ['TWA\\TWS,8,12,16']
  Object.keys(BASE_12).forEach((twa) => {
    const base = BASE_12[twa]
    lines.push([twa, r2(base * 0.8), base, r2(base * 1.15)].join(','))
  })
  return lines.join('\n')
}

module.exports = { createHarness, createRouter, callRoute, useClock, feed, KT, kt, rad, BASE_12, sampleCsv }
