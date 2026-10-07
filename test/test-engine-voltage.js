/**
 * test-engine-voltage.js
 *
 * Verifies the voltage-based alternate engine-running detection
 * (engineVoltageSource/engineVoltageThreshold): with it unset (default),
 * no engineVoltage row appears in /inputs; once configured, feeding a
 * voltage at/above the threshold over the delta websocket flips
 * engineRunning true (reported via /polar/status), and dropping back
 * below the threshold flips it back - independent of propulsion.* data,
 * which this test never sends.
 *
 * Usage:
 *   node test/test-engine-voltage.js
 *   SK_HOST=localhost SK_PORT=3000 node test/test-engine-voltage.js
 *
 * Requires Node 22+ (built-in global WebSocket and fetch). Exits non-zero
 * on the first failed check.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const BASE = `http://${HOST}:${PORT}/plugins/polar-builder`
const WS_URL = `ws://${HOST}:${PORT}/signalk/v1/stream?subscribe=none`
const VOLTAGE_PATH = 'electrical.chargers.1.voltage'

let failures = 0

function assert (cond, msg) {
  if (cond) {
    console.log(`  ok - ${msg}`)
  } else {
    failures += 1
    console.error(`  FAIL - ${msg}`)
  }
}

async function api (path, opts) {
  const res = await fetch(`${BASE}${path}`, opts)
  let body = null
  const text = await res.text()
  try { body = text ? JSON.parse(text) : null } catch (e) { body = text }
  return { ok: res.ok, status: res.status, body }
}

async function setConfig (configuration) {
  return api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, configuration })
  })
}

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForStatus (checkFn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000)
  let last = null
  while (Date.now() < deadline) {
    last = await api('/polar/status')
    if (checkFn(last.body)) return last
    await wait(200)
  }
  return last
}

async function main () {
  console.log(`Testing against ${BASE}\n`)

  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed - is signalk-server running on ' + HOST + ':' + PORT + '?')))
  })
  function sendVoltage (value) {
    ws.send(JSON.stringify({
      context: 'vessels.self',
      updates: [{ source: { label: 'engine-voltage-test' }, timestamp: new Date().toISOString(), values: [{ path: VOLTAGE_PATH, value }] }]
    }))
  }

  console.log('--- Disabled by default ---')
  let r = await setConfig({})
  assert(r.ok, 'reset plugin to default config (engineVoltageSource unset)')
  r = await api('/inputs')
  assert(!r.body.inputs.some((i) => i.id === 'engineVoltage'), 'no engineVoltage row in /inputs when unset')

  console.log('\n--- Enabled: below threshold ---')
  r = await setConfig({ engineVoltageSource: VOLTAGE_PATH, engineVoltageThreshold: 13.2 })
  assert(r.ok, 'enabled plugin with engineVoltageSource configured')
  sendVoltage(12.6)
  r = await waitForStatus((b) => b.latest !== undefined, 5000) // just wait for the delta to land
  await wait(500)
  r = await api('/inputs')
  const row = r.body.inputs.find((i) => i.id === 'engineVoltage')
  assert(!!row && row.active && row.display === '12.60 V', `engineVoltage row shows 12.60 V (got ${row && row.display})`)
  r = await api('/polar/status')
  assert(r.body.engineRunning === false, `engineRunning is false below threshold (got ${r.body.engineRunning})`)

  console.log('\n--- At/above threshold ---')
  sendVoltage(13.8)
  r = await waitForStatus((b) => b.engineRunning === true, 5000)
  assert(r.body.engineRunning === true, `engineRunning is true at 13.8V (got ${r.body.engineRunning})`)

  console.log('\n--- Back below threshold ---')
  sendVoltage(12.6)
  r = await waitForStatus((b) => b.engineRunning === false, 5000)
  assert(r.body.engineRunning === false, `engineRunning returns to false (got ${r.body.engineRunning})`)

  console.log('\n--- Cleanup ---')
  ws.close()
  r = await setConfig({})
  assert(r.ok, 'reset plugin to default config (engineVoltageSource unset)')

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('test-engine-voltage failed to run:', e.message)
  process.exit(1)
})
