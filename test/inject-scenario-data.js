/**
 * inject-scenario-data.js
 *
 * Companion to inject-test-data.js. Feeds a locally-running Signal K
 * server through four distinct scenarios so you can confirm
 * signalk-polar-builder does the right thing in each one:
 *
 *   Usage:
 *     node test/inject-scenario-data.js
 *     SK_HOST=localhost SK_PORT=3000 node test/inject-scenario-data.js
 *
 *   Requires Node 22+ (built-in global WebSocket and fetch). Turn off
 *   Security for local testing, since this sends deltas as an anonymous
 *   client over the main delta stream.
 *
 * What it does:
 *   Phase 1 (5s):  ENGINE - engine running at 1500 RPM with otherwise
 *                  steady wind/speed -> plugin must record ZERO cells
 *                  (engine running always blocks recording).
 *   Phase 2 (20s): UNSTABLE - engine stopped, but TWS/TWA/BSP swing
 *                  wildly (gusty, luffing) and rate of turn spikes above
 *                  threshold -> plugin should stay in "Watching (not
 *                  stable)" and record ZERO new cells.
 *   Phase 3 (40s): ACTIONABLE #1 - engine stopped, steady close-hauled
 *                  sailing at TWS 12kt / TWA 35deg / BSP 5.8kt -> plugin
 *                  should record cells once its stability window elapses.
 *   Phase 4 (40s): ACTIONABLE #2 - engine stopped, steady beam reach at
 *                  TWS 16kt / TWA 90deg / BSP 7.2kt -> plugin should
 *                  record a second, distinct set of cells, giving the
 *                  polar table two real data points.
 *   Throughout, polls /plugins/polar-builder/polar/status every 5s so
 *   you can watch cell count and stability status live.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const WS_URL = `ws://${HOST}:${PORT}/signalk/v1/stream?subscribe=none`
const STATUS_URL = `http://${HOST}:${PORT}/plugins/polar-builder/polar/status`
const POLAR_URL = `http://${HOST}:${PORT}/plugins/polar-builder/polar.json`
const PROFILES_URL = `http://${HOST}:${PORT}/plugins/polar-builder/profiles`

const KTS_TO_MS = 1 / 1.9438444924574
const DEG_TO_RAD = Math.PI / 180

function delta (values) {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'polar-builder-scenario-injector' },
        timestamp: new Date().toISOString(),
        values
      }
    ]
  }
}

function sailingValues ({ bspKt, twsKt, twaDeg, rotDegS }) {
  return [
    { path: 'navigation.speedThroughWater', value: bspKt * KTS_TO_MS },
    { path: 'environment.wind.speedTrue', value: twsKt * KTS_TO_MS },
    { path: 'environment.wind.angleTrueWater', value: twaDeg * DEG_TO_RAD },
    { path: 'navigation.rateOfTurn', value: rotDegS * DEG_TO_RAD }
  ]
}

function engineValues ({ state, rpm }) {
  return [
    { path: 'propulsion.main.state', value: state },
    { path: 'propulsion.main.revolutions', value: rpm / 60 }
  ]
}

function jitter (base, spread) {
  return base + (Math.random() - 0.5) * spread
}

async function printStatus (label) {
  try {
    const res = await fetch(STATUS_URL)
    const json = await res.json()
    console.log(
      `[${label}] cells=${json.cellCount} engineRunning=${json.engineRunning} ` +
      `latestTWS=${json.latest && json.latest.tws ? json.latest.tws.toFixed(1) : 'n/a'}kt`
    )
  } catch (e) {
    console.log(`[${label}] could not reach ${STATUS_URL}: ${e.message}`)
  }
}

function runFor (ws, seconds, tick) {
  let elapsed = 0
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      elapsed += 1
      tick(ws, elapsed)
      if (elapsed >= seconds) {
        clearInterval(iv)
        resolve()
      }
    }, 1000)
  })
}

// Creates (or reactivates) a 'test' profile and switches recording to it,
// so synthetic injector data never lands in your real 'default' polar.
async function ensureTestProfile () {
  try {
    const res = await fetch(PROFILES_URL)
    const json = await res.json()
    const exists = (json.profiles || []).some((p) => p.id === 'test')
    if (exists) {
      await fetch(`${PROFILES_URL}/test/activate`, { method: 'POST' })
    } else {
      await fetch(PROFILES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' })
      })
    }
    console.log("Recording into the 'test' profile (not 'default').\n")
  } catch (e) {
    console.log(`Could not switch to the 'test' profile (${e.message}) - continuing with whatever profile is currently active.\n`)
  }
}

async function main () {
  console.log(`Connecting to ${WS_URL} ...`)
  const ws = new WebSocket(WS_URL)

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed - is signalk-server running on ' + HOST + ':' + PORT + '?')))
  })
  console.log('Connected. Starting scenarios.\n')
  await ensureTestProfile()

  const statusInterval = setInterval(() => printStatus('poll'), 5000)

  // ---- Phase 1: ENGINE - engine running, should block recording --------
  console.log('--- Phase 1 (5s): ENGINE - running at 1500 RPM - expect 0 cells recorded ---')
  await runFor(ws, 5, (sock) => {
    sock.send(JSON.stringify(delta(engineValues({ state: 'started', rpm: 1500 }))))
    sock.send(JSON.stringify(delta(sailingValues({
      bspKt: jitter(6.4, 0.05),
      twsKt: jitter(14, 0.2),
      twaDeg: jitter(40, 1),
      rotDegS: 0.1
    }))))
  })

  // ---- Phase 2: UNSTABLE - engine off, but conditions too erratic ------
  console.log('\n--- Phase 2 (20s): UNSTABLE - engine stopped, gusty/luffing conditions - expect 0 new cells ---')
  await runFor(ws, 20, (sock) => {
    sock.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))
    sock.send(JSON.stringify(delta(sailingValues({
      bspKt: jitter(6, 2.5),        // wide BSP swings (surging/stalling)
      twsKt: jitter(15, 8),         // gusty wind, 11-19kt range
      twaDeg: jitter(40, 40),       // luffing/oscillating angle
      rotDegS: jitter(0, 8)         // occasional rudder corrections above threshold
    }))))
  })

  // ---- Phase 3: ACTIONABLE #1 - steady close-hauled --------------------
  console.log('\n--- Phase 3 (40s): ACTIONABLE - steady close-hauled TWS 12kt / TWA 35deg / BSP 5.8kt ---')
  console.log('(waits out one full stability window before recording resumes - this is expected)\n')
  await runFor(ws, 40, (sock) => {
    sock.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))
    sock.send(JSON.stringify(delta(sailingValues({
      bspKt: jitter(5.8, 0.1),
      twsKt: jitter(12, 0.3),
      twaDeg: jitter(35, 1.5),
      rotDegS: 0.2
    }))))
  })

  // ---- Phase 4: ACTIONABLE #2 - steady beam reach -----------------------
  console.log('\n--- Phase 4 (40s): ACTIONABLE - steady beam reach TWS 16kt / TWA 90deg / BSP 7.2kt ---')
  console.log('(different TWS/TWA bucket - should add a second, distinct set of cells)\n')
  await runFor(ws, 40, (sock) => {
    sock.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))
    sock.send(JSON.stringify(delta(sailingValues({
      bspKt: jitter(7.2, 0.1),
      twsKt: jitter(16, 0.3),
      twaDeg: jitter(90, 1.5),
      rotDegS: 0.2
    }))))
  })

  clearInterval(statusInterval)
  await printStatus('final')

  try {
    const res = await fetch(POLAR_URL)
    const json = await res.json()
    console.log('\nFinal polar.json:\n' + JSON.stringify(json, null, 2))
  } catch (e) {
    console.log('Could not fetch final polar.json:', e.message)
  }

  console.log('\nDone. Expect roughly 2 distinct cells (one near TWS 12/TWA 35, one near TWS 16/TWA 90).')
  console.log('Try:')
  console.log(`  curl ${POLAR_URL}`)
  console.log(`  curl http://${HOST}:${PORT}/plugins/polar-builder/polar/matrix`)
  console.log(`  curl http://${HOST}:${PORT}/plugins/polar-builder/polar/csv`)
  console.log(`  curl -X POST http://${HOST}:${PORT}/plugins/polar-builder/polar/reset   # to wipe and retry`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Scenario injector failed:', e.message)
  process.exit(1)
})
