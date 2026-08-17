/**
 * test-profiles.js
 *
 * Fetch-only (no WebSocket) verification of the multi-profile and
 * import/export REST API against a locally-running signalk-server with
 * signalk-polar-builder installed and enabled. Seeds profiles via
 * /polar/import rather than live sailing data, so this runs in a couple
 * of seconds instead of the ~8.5 minutes inject-realistic-polar.js takes.
 *
 * Usage:
 *   node test/test-profiles.js
 *   SK_HOST=localhost SK_PORT=3000 node test/test-profiles.js
 *
 * Requires Node 22+ (built-in global fetch). Exits non-zero on the first
 * failed check.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const BASE = `http://${HOST}:${PORT}/plugins/polar-builder`

const CSV_A = 'TWA\\TWS,10,15\n40,4.5,5.5\n90,5.5,6.8\n150,4.0,5.2'
const CSV_B = 'TWA\\TWS,10,15\n40,4.9,6.0\n90,6.0,7.4\n150,4.4,5.7'

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

async function main () {
  console.log(`Testing against ${BASE}\n`)

  console.log('--- Initial state ---')
  let r = await api('/profiles')
  assert(r.ok, 'GET /profiles succeeds')
  const initialActive = r.body.active
  console.log(`  initial active profile: ${initialActive}`)

  console.log('\n--- Create profile A (auto-activates) ---')
  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `test-a-${Date.now()}` })
  })
  assert(r.ok, 'POST /profiles creates profile A')
  const idA = r.body.id
  assert(r.body.active === idA, 'profile A is auto-activated on creation')

  console.log('\n--- Seed profile A via import ---')
  r = await api(`/polar/import?profile=${idA}&mode=replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: CSV_A
  })
  assert(r.ok, 'import into profile A succeeds')
  assert(r.body.imported === 6, `imported 6 points into A (got ${r.body && r.body.imported})`)

  console.log('\n--- Create profile B (auto-activates, A stays untouched) ---')
  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `test-b-${Date.now()}` })
  })
  assert(r.ok, 'POST /profiles creates profile B')
  const idB = r.body.id
  assert(r.body.active === idB, 'profile B is now active')

  r = await api(`/polar/import?profile=${idB}&mode=replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: CSV_B
  })
  assert(r.ok, 'import into profile B succeeds')

  console.log('\n--- Profile isolation ---')
  r = await api('/profiles')
  const listed = {}
  r.body.profiles.forEach((p) => { listed[p.id] = p })
  assert(listed[idA] && listed[idA].cellCount === 6, `profile A still has 6 cells (got ${listed[idA] && listed[idA].cellCount})`)
  assert(listed[idB] && listed[idB].cellCount === 6, `profile B has 6 cells (got ${listed[idB] && listed[idB].cellCount})`)

  const matrixA = await api(`/polar/matrix?profile=${idA}`)
  const matrixB = await api(`/polar/matrix?profile=${idB}`)
  const bspA40 = matrixA.body.rows.find((row) => row.twa === 40).speeds['10']
  const bspB40 = matrixB.body.rows.find((row) => row.twa === 40).speeds['10']
  assert(bspA40 === 4.5, `profile A's TWA40/TWS10 cell is 4.5 (got ${bspA40})`)
  assert(bspB40 === 4.9, `profile B's TWA40/TWS10 cell is 4.9, distinct from A (got ${bspB40})`)

  console.log('\n--- Export / import round-trip ---')
  const polRes = await fetch(`${BASE}/polar/export?profile=${idA}&format=pol`)
  const polText = await polRes.text()
  assert(polRes.ok, 'GET /polar/export?format=pol succeeds')
  const headerLine = polText.split('\n')[0]
  assert(headerLine.indexOf('\t') !== -1, 'exported .pol header is tab-delimited')
  assert(headerLine.startsWith('TWA\\TWS'), `exported .pol header starts with TWA\\TWS (got "${headerLine}")`)

  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `test-roundtrip-${Date.now()}` })
  })
  const idC = r.body.id
  r = await api(`/polar/import?profile=${idC}&mode=replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: polText
  })
  assert(r.ok, 'import of exported .pol succeeds')
  assert(r.body.imported === 6, `round-trip import restored 6 points (got ${r.body && r.body.imported})`)

  const matrixC = await api(`/polar/matrix?profile=${idC}`)
  assert(
    JSON.stringify(matrixC.body) === JSON.stringify(matrixA.body),
    'round-tripped matrix (export -> import) matches the original exactly'
  )

  console.log('\n--- Cleanup ---')
  r = await api(`/profiles/${encodeURIComponent(initialActive)}/activate`, { method: 'POST' })
  assert(r.ok && r.body.active === initialActive, `re-activated original profile '${initialActive}'`)

  for (const id of [idA, idB, idC]) {
    r = await api(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
    assert(r.ok, `deleted test profile '${id}'`)
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('test-profiles failed to run:', e.message)
  process.exit(1)
})
