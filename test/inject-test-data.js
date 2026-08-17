/**
 * inject-test-data.js
 *
 * Feeds synthetic navigation/wind/engine deltas into a locally-running
 * Signal K server so you can watch signalk-polar-builder learn cells
 * without actually going sailing.
 *
 * Usage:
 *   node test/inject-test-data.js
 *   SK_HOST=localhost SK_PORT=3000 node test/inject-test-data.js
 *
 * Requires Node 22+ (uses the built-in global WebSocket and fetch).
 * If your server has Security enabled, turn it off for local testing
 * (Server -> Security -> Settings), since this script sends deltas as
 * an anonymous client over the main delta stream.
 *
 * What it does:
 *   Phase 1 (5s):  engine "running" at 1200 RPM + steady wind/speed
 *                  -> plugin should record ZERO cells here.
 *   Phase 2 (45s): engine stopped, steady sailing at TWS 14kt / TWA 40deg
 *                  (signed: positive = starboard) / BSP 6.4kt
 *                  -> plugin should start recording cells once a full
 *                     stability window has passed since the engine
 *                     stopped.
 *   Throughout, polls /plugins/polar-builder/polar/status every 5s and
 *   prints the cell count so you can watch it happen live.
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
        source: { label: 'polar-builder-test-injector' },
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
    ws.addEventListener('error', (e) => reject(new Error('WebSocket connection failed - is signalk-server running on ' + HOST + ':' + PORT + '?')))
  })
  console.log('Connected. Starting simulation.\n')
  await ensureTestProfile()

  const statusInterval = setInterval(() => printStatus('poll'), 5000)

  // ---- Phase 1: engine running -----------------------------------------
  console.log('--- Phase 1 (5s): engine running at 1200 RPM - expect 0 cells recorded ---')
  let elapsed = 0
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      elapsed += 1
      ws.send(JSON.stringify(delta(engineValues({ state: 'started', rpm: 1200 }))))
      ws.send(JSON.stringify(delta(sailingValues({
        bspKt: jitter(6.4, 0.05),
        twsKt: jitter(14, 0.2),
        twaDeg: jitter(40, 1),
        rotDegS: 0.1
      }))))
      if (elapsed >= 5) {
        clearInterval(iv)
        resolve()
      }
    }, 1000)
  })

  // ---- Phase 2: engine stopped, steady sailing --------------------------
  console.log('\n--- Phase 2 (45s): engine stopped, steady sailing TWS 14kt / TWA 40deg / BSP 6.4kt ---')
  console.log('(waits out one full stability window before recording resumes - this is expected)\n')
  ws.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))

  elapsed = 0
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      elapsed += 1
      ws.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))
      ws.send(JSON.stringify(delta(sailingValues({
        bspKt: jitter(6.4, 0.1),
        twsKt: jitter(14, 0.3),
        twaDeg: jitter(40, 1.5),
        rotDegS: 0.2
      }))))
      if (elapsed >= 45) {
        clearInterval(iv)
        resolve()
      }
    }, 1000)
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

  console.log('\nDone. Try:')
  console.log(`  curl ${POLAR_URL}`)
  console.log(`  curl http://${HOST}:${PORT}/plugins/polar-builder/polar/matrix`)
  console.log(`  curl http://${HOST}:${PORT}/plugins/polar-builder/polar/csv`)
  console.log(`  curl -X POST http://${HOST}:${PORT}/plugins/polar-builder/polar/reset   # to wipe and retry`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Test injector failed:', e.message)
  process.exit(1)
})
