/**
 * test-mfd-display.js
 *
 * Verifies the enableMfdDisplay toggle and the read-only MFD tile webapp:
 * with the option off, performance.mfdDisplayEnabled is never published;
 * with it on, the path appears via the standard readonly API
 * (GET /signalk/v1/api/vessels/self/performance/...) and the static tile
 * page at /signalk-polar-builder/mfd/ is reachable. No live sailing data
 * is needed - the mfdDisplayEnabled push isn't gated on sensor freshness,
 * only on the plugin's 1s publish interval.
 *
 * Usage:
 *   node test/test-mfd-display.js
 *   SK_HOST=localhost SK_PORT=3000 node test/test-mfd-display.js
 *
 * Requires Node 22+ (built-in global fetch). Exits non-zero on the first
 * failed check.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const ROOT = `http://${HOST}:${PORT}`
const PLUGIN_BASE = `${ROOT}/plugins/polar-builder`
const PERFORMANCE_URL = `${ROOT}/signalk/v1/api/vessels/self/performance/mfdDisplayEnabled`
const TILE_URL = `${ROOT}/signalk-polar-builder/mfd/`

let failures = 0

function assert (cond, msg) {
  if (cond) {
    console.log(`  ok - ${msg}`)
  } else {
    failures += 1
    console.error(`  FAIL - ${msg}`)
  }
}

async function setConfig (configuration) {
  const res = await fetch(`${PLUGIN_BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, configuration })
  })
  return res.ok
}

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchMfdEnabled () {
  const res = await fetch(PERFORMANCE_URL)
  if (res.status === 404) return { present: false }
  if (!res.ok) return { present: false }
  const body = await res.json()
  return { present: true, value: body && body.value }
}

async function main () {
  console.log(`Testing against ${ROOT}\n`)

  console.log('--- enableMfdDisplay off (default) ---')
  let ok = await setConfig({})
  assert(ok, 'reset plugin to default config (enableMfdDisplay off)')
  await wait(1500)
  let r = await fetchMfdEnabled()
  assert(!r.present, `performance.mfdDisplayEnabled is not published when disabled (present=${r.present})`)

  console.log('\n--- enableMfdDisplay on ---')
  ok = await setConfig({ enableMfdDisplay: true })
  assert(ok, 'enabled plugin with enableMfdDisplay: true')
  await wait(1500)
  r = await fetchMfdEnabled()
  assert(r.present && r.value === true, `performance.mfdDisplayEnabled is true (present=${r.present}, value=${r.value})`)

  console.log('\n--- tile page reachable ---')
  const tileRes = await fetch(TILE_URL)
  assert(tileRes.ok, `GET ${TILE_URL} returns ok (status=${tileRes.status})`)
  const contentType = tileRes.headers.get('content-type') || ''
  assert(contentType.includes('text/html'), `tile page content-type is text/html (got '${contentType}')`)

  console.log('\n--- Cleanup ---')
  ok = await setConfig({})
  assert(ok, 'reset plugin to default config (enableMfdDisplay off)')

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('test-mfd-display failed to run:', e.message)
  process.exit(1)
})
