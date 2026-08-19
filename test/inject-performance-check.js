/**
 * inject-performance-check.js
 *
 * Verifies that signalk-polar-builder actually publishes performance.*
 * deltas onto the Signal K bus (not just its own REST API) - specifically
 * that beatAngleTargetSpeed and gybeAngleTargetSpeed both appear and
 * differ (the plugin's whole point: a target speed that distinguishes
 * upwind from downwind), and that velocityMadeGood's sign flips between
 * an upwind and a downwind heading.
 *
 * Seeds a dedicated 'perf-test' profile via /polar/import (fast and
 * deterministic - skips the stability-detection gate entirely) rather
 * than waiting through a live-sailing simulation like the other
 * test/inject-*.js scripts.
 *
 * Usage:
 *   node test/inject-performance-check.js
 *   SK_HOST=localhost SK_PORT=3000 node test/inject-performance-check.js
 *
 * Requires Node 22+ (built-in global WebSocket and fetch). Exits non-zero
 * on the first failed assertion.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const BASE = `http://${HOST}:${PORT}/plugins/polar-builder`
const WS_URL = `ws://${HOST}:${PORT}/signalk/v1/stream?subscribe=none`

const KTS_TO_MS = 1 / 1.9438444924574
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

// TWA rows x TWS columns - two wind speeds, three angles spanning
// close-hauled / beam reach / deep run, matching this plugin's own
// export shape so it can be POSTed straight back in as an import.
const CSV = 'TWA\\TWS,10,15\n40,4.5,5.5\n90,5.5,6.8\n150,4.0,5.2'

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
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (e) { body = text }
  return { ok: res.ok, status: res.status, body }
}

function delta (values) {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'polar-builder-performance-check' },
        timestamp: new Date().toISOString(),
        values
      }
    ]
  }
}

function normalizeRadTwoPi (r) {
  const twoPi = Math.PI * 2
  let v = r % twoPi
  if (v < 0) v += twoPi
  return v
}

function angleDiffRad (a, b) {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return Math.abs(d)
}

async function main () {
  console.log(`Testing against ${BASE}\n`)

  console.log('--- Setup: seed a dedicated perf-test profile ---')
  let r = await api('/profiles')
  const initialActive = r.body.active

  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `perf-test-${Date.now()}` })
  })
  assert(r.ok, 'created and activated perf-test profile')
  const profileId = r.body.id

  r = await api(`/polar/import?profile=${profileId}&mode=replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: CSV
  })
  assert(r.ok && r.body.imported === 6, `imported 6 points (got ${r.body && r.body.imported})`)

  console.log('\n--- Connecting and subscribing to performance.* ---')
  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed - is signalk-server running on ' + HOST + ':' + PORT + '?')))
  })

  const received = {}
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (e) { return }
    ;(msg.updates || []).forEach((u) => {
      ;(u.values || []).forEach((v) => {
        if (typeof v.path === 'string' && v.path.indexOf('performance.') === 0) {
          received[v.path] = v.value
        }
      })
    })
  })

  ws.send(JSON.stringify({
    context: 'vessels.self',
    subscribe: [{ path: 'performance.*', period: 500 }]
  }))

  function feedFor (seconds, values) {
    let elapsed = 0
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        elapsed += 1
        ws.send(JSON.stringify(delta(values())))
        if (elapsed >= seconds) { clearInterval(iv); resolve() }
      }, 1000)
    })
  }

  console.log('\n--- Upwind scenario: TWS 12kt / TWA 40deg / heading 0deg ---')
  Object.keys(received).forEach((k) => delete received[k])
  await feedFor(4, () => [
    { path: 'environment.wind.speedTrue', value: 12 * KTS_TO_MS },
    { path: 'environment.wind.angleTrueWater', value: 40 * DEG_TO_RAD },
    { path: 'navigation.speedThroughWater', value: 4.8 * KTS_TO_MS },
    { path: 'navigation.rateOfTurn', value: 0 },
    { path: 'navigation.headingTrue', value: 0 }
  ])
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert(typeof received['performance.velocityMadeGood'] === 'number' && received['performance.velocityMadeGood'] > 0,
    `velocityMadeGood is positive upwind (got ${received['performance.velocityMadeGood']})`)
  assert(typeof received['performance.beatAngleTargetSpeed'] === 'number', 'beatAngleTargetSpeed is present')
  assert(typeof received['performance.gybeAngleTargetSpeed'] === 'number', 'gybeAngleTargetSpeed is present')
  assert(
    received['performance.beatAngleTargetSpeed'] !== received['performance.gybeAngleTargetSpeed'],
    `beatAngleTargetSpeed (${received['performance.beatAngleTargetSpeed']}) differs from gybeAngleTargetSpeed (${received['performance.gybeAngleTargetSpeed']}) - the up/down-wind distinction`
  )
  assert(typeof received['performance.targetSpeed'] === 'number', 'targetSpeed is present (upwind -> should equal beatAngleTargetSpeed)')
  if (typeof received['performance.targetSpeed'] === 'number' && typeof received['performance.beatAngleTargetSpeed'] === 'number') {
    assert(Math.abs(received['performance.targetSpeed'] - received['performance.beatAngleTargetSpeed']) < 1e-6, 'targetSpeed matches beatAngleTargetSpeed while sailing upwind')
  }

  const expectedTackTrue = normalizeRadTwoPi(0 + 2 * (40 * DEG_TO_RAD))
  assert(typeof received['performance.tackTrue'] === 'number', 'tackTrue is present')
  if (typeof received['performance.tackTrue'] === 'number') {
    assert(
      angleDiffRad(received['performance.tackTrue'], expectedTackTrue) < 0.05,
      `tackTrue ~= heading + 2*TWA (got ${(received['performance.tackTrue'] * RAD_TO_DEG).toFixed(1)}deg, expected ~${(expectedTackTrue * RAD_TO_DEG).toFixed(1)}deg)`
    )
  }

  console.log('\n--- Downwind scenario: TWS 12kt / TWA 150deg ---')
  Object.keys(received).forEach((k) => delete received[k])
  await feedFor(4, () => [
    { path: 'environment.wind.speedTrue', value: 12 * KTS_TO_MS },
    { path: 'environment.wind.angleTrueWater', value: 150 * DEG_TO_RAD },
    { path: 'navigation.speedThroughWater', value: 4.3 * KTS_TO_MS },
    { path: 'navigation.rateOfTurn', value: 0 }
  ])
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert(typeof received['performance.velocityMadeGood'] === 'number' && received['performance.velocityMadeGood'] < 0,
    `velocityMadeGood is negative downwind (got ${received['performance.velocityMadeGood']})`)

  console.log('\n--- Cleanup ---')
  r = await api(`/profiles/${encodeURIComponent(initialActive)}/activate`, { method: 'POST' })
  assert(r.ok && r.body.active === initialActive, `re-activated original profile '${initialActive}'`)
  r = await api(`/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' })
  assert(r.ok, `deleted perf-test profile '${profileId}'`)

  ws.close()
  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('inject-performance-check failed to run:', e.message)
  process.exit(1)
})
