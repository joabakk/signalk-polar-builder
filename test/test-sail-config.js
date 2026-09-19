/**
 * test-sail-config.js
 *
 * Verifies sail-configuration tagging and the opt-in autoSwitchBySailConfig
 * behavior: tag two profiles with different sail configs, feed
 * sails.inventory.* deltas over the delta websocket (there's no REST
 * shortcut for live input state the way /polar/import is for cell data),
 * and confirm the active profile follows the live sail config only when
 * autoSwitchBySailConfig is on - never when it's off, even though a
 * matching tag exists.
 *
 * Usage:
 *   node test/test-sail-config.js
 *   SK_HOST=localhost SK_PORT=3000 node test/test-sail-config.js
 *
 * Requires Node 22+ (built-in global WebSocket and fetch). Exits non-zero
 * on the first failed check.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const BASE = `http://${HOST}:${PORT}/plugins/polar-builder`
const WS_URL = `ws://${HOST}:${PORT}/signalk/v1/stream?subscribe=none`

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

// Polls GET /profiles until checkFn(body) is true or timeoutMs elapses,
// returning the last-seen body either way - delta propagation (WS send ->
// server dispatch -> plugin subscription callback -> in-memory state) has
// no fixed latency bound, so a single fixed wait is inherently flaky.
async function waitForProfiles (checkFn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000)
  let last = null
  while (Date.now() < deadline) {
    last = await api('/profiles')
    if (checkFn(last.body)) return last
    await wait(200)
  }
  return last
}

async function main () {
  console.log(`Testing against ${BASE}\n`)

  console.log('--- Setup ---')
  let r = await api('/profiles')
  const initialActive = r.body.active

  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed - is signalk-server running on ' + HOST + ':' + PORT + '?')))
  })
  function sendSail (id, values) {
    ws.send(JSON.stringify({
      context: 'vessels.self',
      updates: [{ source: { label: 'sail-config-test' }, timestamp: new Date().toISOString(), values: values.map((v) => ({
        path: `sails.inventory.${id}.${v.path}`,
        value: v.value
      })) }]
    }))
  }

  r = await setConfig({ autoSwitchBySailConfig: true })
  assert(r.ok, 'enabled plugin with autoSwitchBySailConfig: true')

  // Sail state lives in plugin memory, not per-test-run - a previous run
  // against this same server could leave main/j1 marked active. Force a
  // known clean baseline (nothing active) before the real test sequence,
  // so every transition below is a genuine change the auto-switch logic
  // actually has to react to, not a no-op against leftover state.
  sendSail('main', [{ path: 'active', value: false }])
  sendSail('j1', [{ path: 'active', value: false }])
  await waitForProfiles((b) => b.currentSailConfig === null, 5000)

  console.log('\n--- Create and tag two profiles ---')
  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `sail-test-main-${Date.now()}` })
  })
  const mainOnlyId = r.body.id
  r = await api(`/profiles/${mainOnlyId}/sail-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sailConfig: 'Main' })
  })
  assert(r.ok && r.body.sailConfig === 'Main', `tagged '${mainOnlyId}' with 'Main'`)

  r = await api('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `sail-test-full-${Date.now()}` })
  })
  const fullSailId = r.body.id
  r = await api(`/profiles/${fullSailId}/sail-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sailConfig: 'J1+Main' })
  })
  assert(r.ok && r.body.sailConfig === 'J1+Main', `tagged '${fullSailId}' with 'J1+Main'`)

  console.log('\n--- Auto-switch ON: hoist Main, then add J1 ---')
  sendSail('main', [{ path: 'active', value: true }, { path: 'name', value: 'Main' }])
  r = await waitForProfiles((b) => b.currentSailConfig === 'Main', 5000)
  assert(r.body.currentSailConfig === 'Main', `currentSailConfig is 'Main' (got '${r.body.currentSailConfig}')`)
  assert(r.body.active === mainOnlyId, `auto-switched to '${mainOnlyId}' for 'Main' (active is '${r.body.active}')`)

  sendSail('j1', [{ path: 'active', value: true }, { path: 'name', value: 'J1' }])
  r = await waitForProfiles((b) => b.currentSailConfig === 'J1+Main', 5000)
  assert(r.body.currentSailConfig === 'J1+Main', `currentSailConfig is 'J1+Main' (got '${r.body.currentSailConfig}')`)
  assert(r.body.active === fullSailId, `auto-switched to '${fullSailId}' for 'J1+Main' (active is '${r.body.active}')`)

  console.log('\n--- Auto-switch ON: drop J1, should switch back ---')
  sendSail('j1', [{ path: 'active', value: false }])
  r = await waitForProfiles((b) => b.currentSailConfig === 'Main', 5000)
  assert(r.body.currentSailConfig === 'Main', `currentSailConfig back to 'Main' (got '${r.body.currentSailConfig}')`)
  assert(r.body.active === mainOnlyId, `auto-switched back to '${mainOnlyId}' (active is '${r.body.active}')`)

  console.log('\n--- Auto-switch OFF: matching tag exists but must NOT switch ---')
  r = await setConfig({})
  assert(r.ok, 'reset plugin to default config (autoSwitchBySailConfig off)')
  r = await api(`/profiles/${mainOnlyId}/activate`, { method: 'POST' })
  assert(r.ok && r.body.active === mainOnlyId, `explicitly activated '${mainOnlyId}' as a known baseline`)

  sendSail('j1', [{ path: 'active', value: true }])
  r = await waitForProfiles((b) => b.currentSailConfig === 'J1+Main', 5000)
  assert(r.body.currentSailConfig === 'J1+Main', `currentSailConfig is 'J1+Main' again (got '${r.body.currentSailConfig}')`)
  assert(r.body.active === mainOnlyId, `did NOT auto-switch while disabled (active is still '${r.body.active}', expected '${mainOnlyId}')`)

  console.log('\n--- Cleanup ---')
  sendSail('j1', [{ path: 'active', value: false }])
  ws.close()
  r = await api(`/profiles/${encodeURIComponent(initialActive)}/activate`, { method: 'POST' })
  assert(r.ok && r.body.active === initialActive, `re-activated original profile '${initialActive}'`)
  for (const id of [mainOnlyId, fullSailId]) {
    r = await api(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
    assert(r.ok, `deleted test profile '${id}'`)
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('test-sail-config failed to run:', e.message)
  process.exit(1)
})
