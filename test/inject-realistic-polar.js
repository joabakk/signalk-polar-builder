/**
 * inject-realistic-polar.js
 *
 * Feeds a locally-running Signal K server a plausible multi-point cruiser
 * -racer polar (roughly ~35ft performance cruiser numbers, hand-picked -
 * not real VPP output) so you can watch signalk-polar-builder's table -
 * and the /signalk-polar-builder/ webapp's chart, including the VMG
 * laylines - actually fill in with a realistic-looking curve instead of
 * just one or two isolated points.
 *
 * Usage:
 *   node test/inject-realistic-polar.js
 *   SK_HOST=localhost SK_PORT=3000 node test/inject-realistic-polar.js
 *
 * Requires Node 22+ (built-in global WebSocket and fetch). Turn off
 * Security for local testing, since this sends deltas as an anonymous
 * client over the main delta stream.
 *
 * Steps through 4 wind speeds (8/12/16/20kt) x 7 wind angles (35deg
 * close-hauled through 165deg deep run) = 28 points. Each point holds
 * steady for 18s (a full default stabilityWindowSeconds=12s plus margin)
 * with the engine "stopped" throughout, so the plugin should record
 * exactly one new cell per point. With default settings this takes
 * about 8.5 minutes - while it runs, open
 * http://<host>:<port>/signalk-polar-builder/ and watch the curve build.
 */

const HOST = process.env.SK_HOST || 'localhost'
const PORT = process.env.SK_PORT || '3000'
const WS_URL = `ws://${HOST}:${PORT}/signalk/v1/stream?subscribe=none`
const STATUS_URL = `http://${HOST}:${PORT}/plugins/polar-builder/polar/status`
const POLAR_URL = `http://${HOST}:${PORT}/plugins/polar-builder/polar.json`
const MATRIX_URL = `http://${HOST}:${PORT}/plugins/polar-builder/polar/matrix`
const PROFILES_URL = `http://${HOST}:${PORT}/plugins/polar-builder/profiles`

const KTS_TO_MS = 1 / 1.9438444924574
const DEG_TO_RAD = Math.PI / 180
const SECONDS_PER_POINT = 18

// Hand-picked, plausible (not real VPP-derived) boat speeds in knots,
// keyed by TWA then TWS - roughly a ~35ft performance cruiser.
const POLAR_TABLE = {
  35: { 8: 4.6, 12: 5.6, 16: 6.0, 20: 6.1 },
  50: { 8: 5.8, 12: 6.7, 16: 7.1, 20: 7.2 },
  75: { 8: 6.3, 12: 7.3, 16: 7.9, 20: 8.2 },
  90: { 8: 6.2, 12: 7.4, 16: 8.2, 20: 8.7 },
  110: { 8: 6.0, 12: 7.3, 16: 8.3, 20: 9.0 },
  130: { 8: 5.5, 12: 6.9, 16: 8.0, 20: 8.8 },
  165: { 8: 4.4, 12: 5.7, 16: 6.8, 20: 7.6 }
}
const TWS_VALUES = [8, 12, 16, 20]

function delta (values) {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'polar-builder-realistic-injector' },
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
    console.log(`[${label}] cells=${json.cellCount}`)
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
  await ensureTestProfile()

  const points = []
  Object.keys(POLAR_TABLE).forEach((twa) => {
    TWS_VALUES.forEach((tws) => {
      points.push({ twa: Number(twa), tws, bsp: POLAR_TABLE[twa][tws] })
    })
  })

  console.log(`Connected. Feeding ${points.length} points, ${SECONDS_PER_POINT}s each (~${Math.round(points.length * SECONDS_PER_POINT / 60)} min total).`)
  console.log(`Watch it build live at http://${HOST}:${PORT}/signalk-polar-builder/\n`)

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    console.log(`--- Point ${i + 1}/${points.length}: TWS ${p.tws}kt / TWA ${p.twa}deg -> target BSP ${p.bsp}kt ---`)
    await runFor(ws, SECONDS_PER_POINT, (sock) => {
      sock.send(JSON.stringify(delta(engineValues({ state: 'stopped', rpm: 0 }))))
      sock.send(JSON.stringify(delta(sailingValues({
        bspKt: jitter(p.bsp, 0.1),
        twsKt: jitter(p.tws, 0.3),
        twaDeg: jitter(p.twa, 1.5),
        rotDegS: 0.2
      }))))
    })
    await printStatus('progress')
  }

  await printStatus('final')

  try {
    const res = await fetch(MATRIX_URL)
    const json = await res.json()
    console.log('\nFinal polar/matrix:\n' + JSON.stringify(json, null, 2))
  } catch (e) {
    console.log('Could not fetch final matrix:', e.message)
  }

  console.log('\nDone. Try:')
  console.log(`  open http://${HOST}:${PORT}/signalk-polar-builder/`)
  console.log(`  curl ${POLAR_URL}`)
  console.log(`  curl ${MATRIX_URL}`)
  console.log(`  curl -X POST http://${HOST}:${PORT}/plugins/polar-builder/polar/reset   # to wipe and retry`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Realistic polar injector failed:', e.message)
  process.exit(1)
})
