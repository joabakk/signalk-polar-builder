/**
 * signalk-polar-builder
 *
 * A Signal K server plugin that passively watches wind and boat-speed deltas,
 * detects periods of "stable" (steady-state) sailing, and uses those
 * moments to build up a polar diagram (boat speed as a function of
 * True Wind Speed and True Wind Angle).
 *
 * The table is "self-expanding": instead of a fixed-size matrix, cells
 * are stored in a sparse Map keyed by (TWS bucket, TWA bucket). New
 * buckets appear automatically the first time that combination of wind
 * conditions is observed - there's no predefined grid to configure.
 *
 * Data is persisted to disk (in the plugin's SK data directory) and is
 * exposed over a small REST API for other apps (e.g. an instrument
 * display or a routing tool) to consume.
 */

const fs = require('fs')
const path = require('path')

const MS_TO_KNOTS = 1.9438444924574
const PERFORMANCE_STALENESS_MS = 10000

module.exports = function (app) {
  const plugin = {}

  plugin.id = 'polar-builder'
  plugin.name = 'Self-Expanding Polar Diagram Builder'
  plugin.description =
    'Builds a boat-speed polar table (vs TWS/TWA) from live Signal K data during periods of stable sailing.'

  // ---- runtime state -------------------------------------------------
  let unsubscribes = []
  let stabilityTimer = null
  let persistTimer = null
  let performanceTimer = null
  let options = {}
  let dataFile = null

  let latest = {
    tws: null, // knots
    twa: null, // degrees, signed -180..180
    bsp: null, // knots
    rot: null, // deg/s
    headingTrue: null, // radians
    headingMagnetic: null, // radians
    heelRad: null, // radians, +ve = list to starboard
    twsTime: 0,
    twaTime: 0,
    bspTime: 0,
    rotTime: 0,
    headingTrueTime: 0,
    headingMagneticTime: 0,
    heelTime: 0
  }

  let lastSampleTime = 0

  // Damped TWS used only to pick which polar-table column to read for
  // published performance data (a separate control from the webapp's own
  // client-side damping slider - see performanceDampingSeconds).
  let dampedTws = null
  let lastDampedTwsUpdate = 0

  // Engine state: per-instance revolutions/state, keyed by propulsion instance
  // id (e.g. "port", "main"). Any instance running is enough to block recording.
  let engines = {}
  let engineRunning = false
  let engineStateChangedAt = Date.now()

  // Sliding windows of recent {t, v} samples used to judge stability
  const windows = {
    tws: new SlidingWindow(),
    twa: new SlidingWindow(),
    bsp: new SlidingWindow()
  }

  // The polar store itself: Map<"twsBucket|twaBucket", Cell>, one per profile.
  // `cells` is always an alias for profiles[activeProfileId].cells - reassigned
  // on activate, never copied - so recordSample/checkStability/etc. below need
  // no changes to work against whichever profile is currently active.
  function makeProfile (name) {
    const now = Date.now()
    return { name, cells: new Map(), createdAt: now, lastUpdated: now }
  }
  let profiles = { default: makeProfile('default') }
  let activeProfileId = 'default'
  let cells = profiles[activeProfileId].cells
  let dirty = false

  function activateProfile (id) {
    if (!profiles[id]) return false
    activeProfileId = id
    cells = profiles[id].cells
    return true
  }

  function slugify (name) {
    return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  }

  function resolveProfile (req) {
    const id = req.query && req.query.profile
    if (!id) return { id: activeProfileId, profile: profiles[activeProfileId] }
    if (!profiles[id]) return null
    return { id, profile: profiles[id] }
  }

  // ---- helpers ---------------------------------------------------------

  function SlidingWindow () {
    this.points = []
  }
  SlidingWindow.prototype.push = function (t, v) {
    this.points.push([t, v])
  }
  SlidingWindow.prototype.trim = function (cutoff) {
    while (this.points.length && this.points[0][0] < cutoff) this.points.shift()
  }
  SlidingWindow.prototype.values = function () {
    return this.points.map((p) => p[1])
  }
  SlidingWindow.prototype.span = function () {
    if (this.points.length < 2) return 0
    return this.points[this.points.length - 1][0] - this.points[0][0]
  }

  function mean (arr) {
    if (!arr.length) return null
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  function stddev (arr) {
    if (arr.length < 2) return 0
    const m = mean(arr)
    const variance = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length
    return Math.sqrt(variance)
  }

  // Circular (angular) mean/stddev in degrees - handles wraparound at +/-180
  function circularStats (anglesDeg) {
    if (!anglesDeg.length) return { mean: null, std: 0 }
    let sumSin = 0
    let sumCos = 0
    anglesDeg.forEach((a) => {
      const r = (a * Math.PI) / 180
      sumSin += Math.sin(r)
      sumCos += Math.cos(r)
    })
    const n = anglesDeg.length
    const meanDeg = (Math.atan2(sumSin / n, sumCos / n) * 180) / Math.PI
    const R = Math.sqrt(sumSin * sumSin + sumCos * sumCos) / n
    const clampedR = Math.min(Math.max(R, 1e-9), 1)
    const stdDeg = Math.sqrt(-2 * Math.log(clampedR)) * (180 / Math.PI)
    return { mean: meanDeg, std: isFinite(stdDeg) ? stdDeg : 0 }
  }

  function normalizeAngleDeg (deg) {
    let d = deg % 360
    if (d > 180) d -= 360
    if (d < -180) d += 360
    return d
  }

  function radToDeg (r) {
    return (r * 180) / Math.PI
  }

  function degToRad (d) {
    return (d * Math.PI) / 180
  }

  function ktToMs (kt) {
    return kt / MS_TO_KNOTS
  }

  // Brings a radian angle into [0, 2*PI) - for compass-style headings,
  // distinct from normalizeAngleDeg's signed -180..180 (boat-relative TWA).
  function normalizeHeadingRad (r) {
    const twoPi = Math.PI * 2
    let v = r % twoPi
    if (v < 0) v += twoPi
    return v
  }

  // Exponential moving average, time-aware so irregular delta arrival
  // doesn't bias the time constant - same formula already used client-side
  // in public/index.html for the webapp's own TWS damping slider.
  function emaUpdate (prev, sample, dtSeconds, tauSeconds) {
    if (prev == null || dtSeconds <= 0) return sample
    const alpha = 1 - Math.exp(-dtSeconds / tauSeconds)
    return prev + alpha * (sample - prev)
  }

  function percentile (arr, p) {
    if (!arr.length) return null
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = (p / 100) * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    if (lo === hi) return sorted[lo]
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }

  function round (v, dp) {
    const f = Math.pow(10, dp)
    return Math.round(v * f) / f
  }

  // ---- engine detection --------------------------------------------------

  function setEngineRunning (running) {
    if (running !== engineRunning) {
      engineRunning = running
      engineStateChangedAt = Date.now()
      app.debug(`polar-builder: engine ${running ? 'started' : 'stopped'}`)
    }
  }

  function recomputeEngineRunning () {
    const running = Object.keys(engines).some((id) => {
      const e = engines[id]
      if (e.state && e.state !== 'stopped') return true
      if (typeof e.revolutionsHz === 'number' && Math.abs(e.revolutionsHz) * 60 >= options.engineRpmThreshold) {
        return true
      }
      return false
    })
    setEngineRunning(running)
  }

  function updateEngineFromPath (path, value, now) {
    // Matches propulsion.<instance>.revolutions and propulsion.<instance>.state
    const parts = path.split('.')
    if (parts.length < 3 || parts[0] !== 'propulsion') return false
    const instance = parts[1]
    const field = parts[parts.length - 1]
    if (field !== 'revolutions' && field !== 'state') return false

    if (!engines[instance]) engines[instance] = {}
    if (field === 'revolutions') {
      engines[instance].revolutionsHz = value
    } else {
      engines[instance].state = value
    }
    engines[instance].lastUpdate = now
    recomputeEngineRunning()
    return true
  }

  // ---- polar cell storage ----------------------------------------------

  function cellKey (twsBucket, twaBucket) {
    return twsBucket + '|' + twaBucket
  }

  function recordSample (tws, twa, bsp) {
    const twsBucket = round(Math.round(tws / options.twsBucketSize) * options.twsBucketSize, 2)
    // Signed TWA keeps port (-) and starboard (+) separate, e.g. for boats
    // with an asymmetric rig or a strong preferred gybe. Unsigned (default)
    // folds port/starboard together, which halves the data needed to fill
    // out a symmetric table.
    let twaForBucket = normalizeAngleDeg(twa)
    if (!options.useSignedTwa) twaForBucket = Math.abs(twaForBucket)
    const twaBucket = Math.round(twaForBucket / options.twaBucketSize) * options.twaBucketSize

    const key = cellKey(twsBucket, twaBucket)
    let cell = cells.get(key)
    if (!cell) {
      cell = {
        tws: twsBucket,
        twa: twaBucket,
        count: 0,
        avgBsp: 0,
        maxBsp: 0,
        samples: [],
        firstSeen: Date.now(),
        lastUpdated: Date.now()
      }
      cells.set(key, cell)
    }

    cell.count += 1
    cell.avgBsp = cell.avgBsp + (bsp - cell.avgBsp) / cell.count
    if (bsp > cell.maxBsp) cell.maxBsp = bsp
    cell.lastUpdated = Date.now()

    cell.samples.push(bsp)
    if (cell.samples.length > options.samplesPerCell) {
      cell.samples.shift()
    }

    dirty = true
    profiles[activeProfileId].lastUpdated = Date.now()

    app.debug(
      `polar-builder: recorded sample TWS=${twsBucket}kt TWA=${twaBucket}deg BSP=${round(bsp, 2)}kt (cell count=${cell.count})`
    )
  }

  // ---- stability detection ----------------------------------------------

  function checkStability () {
    const now = Date.now()
    const windowMs = options.stabilityWindowSeconds * 1000
    const cutoff = now - windowMs

    // Never record while the engine is running (motoring speed isn't sailing
    // performance), and require the engine to have been off for at least a
    // full stability window before trusting the data - otherwise a stop
    // right at the edge of the window can leak motor-assisted speed in.
    if (engineRunning) {
      app.setPluginStatus(`Engine running - not recording - ${cells.size} cells recorded so far`)
      return
    }
    if (now - engineStateChangedAt < windowMs) {
      app.setPluginStatus(`Engine recently stopped, waiting for clean data - ${cells.size} cells recorded so far`)
      return
    }

    windows.tws.trim(cutoff)
    windows.twa.trim(cutoff)
    windows.bsp.trim(cutoff)

    // Need a full window of data on all three channels
    if (
      windows.tws.span() < windowMs * 0.8 ||
      windows.twa.span() < windowMs * 0.8 ||
      windows.bsp.span() < windowMs * 0.8
    ) {
      return
    }

    // Data must also be reasonably fresh (no stale/frozen sensor)
    if (
      now - latest.twsTime > windowMs ||
      now - latest.twaTime > windowMs ||
      now - latest.bspTime > windowMs
    ) {
      return
    }

    const twsVals = windows.tws.values()
    const bspVals = windows.bsp.values()
    const twaVals = windows.twa.values()

    const twsStd = stddev(twsVals)
    const bspStd = stddev(bspVals)
    const twaStats = circularStats(twaVals)

    const rotOk =
      latest.rot === null || Math.abs(latest.rot) <= options.maxRateOfTurn

    const twsMean = mean(twsVals)
    const bspMean = mean(bspVals)

    const withinRange =
      twsMean >= options.minTws &&
      twsMean <= options.maxTws &&
      bspMean >= options.minBsp

    const stable =
      withinRange &&
      rotOk &&
      twsStd <= options.maxTwsStdDev &&
      bspStd <= options.maxSpeedStdDev &&
      twaStats.std <= options.maxTwaStdDev

    app.setPluginStatus(
      stable
        ? `Stable: TWS ${round(twsMean, 1)}kt TWA ${round(twaStats.mean, 0)}deg BSP ${round(bspMean, 2)}kt - ${cells.size} cells`
        : `Watching (not stable) - ${cells.size} cells recorded so far`
    )

    if (!stable) return
    if (now - lastSampleTime < options.sampleIntervalSeconds * 1000) return

    lastSampleTime = now
    recordSample(twsMean, twaStats.mean, bspMean)
  }

  // ---- performance data publishing ---------------------------------------
  //
  // Publishes standard Signal K performance.* deltas (velocityMadeGood,
  // polarSpeed, beat/gybe angle+VMG+target speed, tackTrue/tackMagnetic)
  // so any generic Signal K consumer - gauges, chart plotters, or the
  // sk-to-nmea0183/sk-to-nmea2000 gateway plugins - can display them with
  // no knowledge of this plugin. Deliberately NOT gated on the engine/
  // stability logic above: that gate exists to protect what gets recorded
  // into the polar table, not what gets reported as current performance,
  // so these values stay populated while motoring or between stability
  // windows.

  function publishPerformance () {
    if (!options.publishPerformanceData) return

    const now = Date.now()
    const values = []

    const bspFresh = latest.bsp !== null && now - latest.bspTime <= PERFORMANCE_STALENESS_MS
    const twaFresh = latest.twa !== null && now - latest.twaTime <= PERFORMANCE_STALENESS_MS
    const twsFresh = latest.tws !== null && now - latest.twsTime <= PERFORMANCE_STALENESS_MS

    // velocityMadeGood and tack heading need no polar data at all.
    if (bspFresh && twaFresh) {
      values.push({ path: 'performance.velocityMadeGood', value: ktToMs(rawVmgKt(latest.twa, latest.bsp)) })
    }
    if (twaFresh) {
      if (latest.headingTrue !== null && now - latest.headingTrueTime <= PERFORMANCE_STALENESS_MS) {
        values.push({ path: 'performance.tackTrue', value: normalizeHeadingRad(latest.headingTrue + 2 * degToRad(latest.twa)) })
      }
      if (latest.headingMagnetic !== null && now - latest.headingMagneticTime <= PERFORMANCE_STALENESS_MS) {
        values.push({ path: 'performance.tackMagnetic', value: normalizeHeadingRad(latest.headingMagnetic + 2 * degToRad(latest.twa)) })
      }
    }

    if (cells.size > 0 && twsFresh && twaFresh && dampedTws !== null) {
      const matrix = buildMatrix(true, cells)
      const curve = buildCurve(matrix.tws, matrix.rows, dampedTws)
      const points = curve.points

      const polarSpeedKt = interpolateAtTwa(points, latest.twa)
      if (polarSpeedKt !== null) {
        values.push({ path: 'performance.polarSpeed', value: ktToMs(polarSpeedKt) })
        if (bspFresh && polarSpeedKt > 0) {
          values.push({ path: 'performance.polarSpeedRatio', value: latest.bsp / polarSpeedKt })
        }
      }

      const beatGybe = computeBeatGybe(points, latest.twa, options.useSignedTwa)
      const beat = beatGybe.beat
      const gybe = beatGybe.gybe

      if (beat) {
        values.push({ path: 'performance.beatAngle', value: degToRad(beat.twa) })
        values.push({ path: 'performance.beatAngleVelocityMadeGood', value: ktToMs(rawVmgKt(beat.twa, beat.bsp)) })
        values.push({ path: 'performance.beatAngleTargetSpeed', value: ktToMs(beat.bsp) })
      }
      if (gybe) {
        values.push({ path: 'performance.gybeAngle', value: degToRad(gybe.twa) })
        values.push({ path: 'performance.gybeAngleVelocityMadeGood', value: ktToMs(rawVmgKt(gybe.twa, gybe.bsp)) })
        values.push({ path: 'performance.gybeAngleTargetSpeed', value: ktToMs(gybe.bsp) })
      }

      const upwind = Math.abs(normalizeAngleDeg(latest.twa)) < 90
      if (upwind && beat) {
        values.push({ path: 'performance.targetSpeed', value: ktToMs(beat.bsp) })
        values.push({ path: 'performance.targetAngle', value: degToRad(beat.twa) })
      } else if (!upwind && gybe) {
        values.push({ path: 'performance.targetSpeed', value: ktToMs(gybe.bsp) })
        values.push({ path: 'performance.targetAngle', value: degToRad(gybe.twa) })
      }
    }

    if (values.length) {
      app.handleMessage(plugin.id, {
        updates: [{ timestamp: new Date().toISOString(), values }]
      })
    }
  }

  // ---- input status --------------------------------------------------

  function isFresh (time) {
    return !!time && Date.now() - time <= PERFORMANCE_STALENESS_MS
  }

  // Reports every Signal K path this plugin subscribes to, whether it's
  // "required" (the plugin can't do its core job without it) or optional
  // (enables one specific enhancement), and whether data is currently
  // flowing - used by the webapp's Inputs panel so a setup problem is
  // visible at a glance instead of just silently recording nothing.
  function getInputsStatus () {
    const inputs = [
      {
        id: 'bsp',
        label: 'Boat speed',
        path: options.speedSource,
        required: true,
        active: isFresh(latest.bspTime),
        display: latest.bsp !== null ? `${round(latest.bsp, 1)} kt` : null
      },
      {
        id: 'tws',
        label: 'True wind speed',
        path: 'environment.wind.speedTrue',
        required: true,
        active: isFresh(latest.twsTime),
        display: latest.tws !== null ? `${round(latest.tws, 1)} kt` : null
      },
      {
        id: 'twa',
        label: 'True wind angle',
        path: options.windAngleSource,
        required: true,
        active: isFresh(latest.twaTime),
        display: latest.twa !== null ? `${round(latest.twa, 0)}°` : null
      },
      {
        id: 'rot',
        label: 'Rate of turn',
        path: 'navigation.rateOfTurn',
        required: false,
        active: isFresh(latest.rotTime),
        display: latest.rot !== null ? `${round(latest.rot, 1)}°/s` : null
      },
      {
        id: 'headingTrue',
        label: 'Heading (true)',
        path: 'navigation.headingTrue',
        required: false,
        active: isFresh(latest.headingTrueTime),
        display: latest.headingTrue !== null ? `${round(radToDeg(latest.headingTrue), 0)}°` : null
      },
      {
        id: 'headingMagnetic',
        label: 'Heading (magnetic)',
        path: 'navigation.headingMagnetic',
        required: false,
        active: isFresh(latest.headingMagneticTime),
        display: latest.headingMagnetic !== null ? `${round(radToDeg(latest.headingMagnetic), 0)}°` : null
      },
      {
        id: 'heel',
        label: 'Heel / attitude',
        path: 'navigation.attitude',
        required: false,
        active: isFresh(latest.heelTime),
        display: latest.heelRad !== null ? `${round(radToDeg(latest.heelRad), 1)}°` : null
      }
    ]

    const engineIds = Object.keys(engines)
    if (!engineIds.length) {
      inputs.push({
        id: 'engine',
        label: 'Engine (propulsion.*)',
        path: 'propulsion.*.state / .revolutions',
        required: false,
        active: false,
        display: null
      })
    } else {
      engineIds.forEach((id) => {
        const e = engines[id]
        inputs.push({
          id: `engine:${id}`,
          label: `Engine: ${id}`,
          path: `propulsion.${id}.state / .revolutions`,
          required: false,
          active: isFresh(e.lastUpdate),
          display: e.state || (typeof e.revolutionsHz === 'number' ? `${round(e.revolutionsHz * 60, 0)} rpm` : null)
        })
      })
    }

    return inputs
  }

  // ---- persistence ----------------------------------------------------

  function loadFromDisk () {
    try {
      if (fs.existsSync(dataFile)) {
        const raw = fs.readFileSync(dataFile, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed.profiles) {
          profiles = {}
          Object.keys(parsed.profiles).forEach((id) => {
            const p = parsed.profiles[id]
            profiles[id] = {
              name: p.name || id,
              cells: new Map(p.cells || []),
              createdAt: p.createdAt || Date.now(),
              lastUpdated: p.lastUpdated || Date.now()
            }
          })
          activeProfileId = profiles[parsed.activeProfile] ? parsed.activeProfile : Object.keys(profiles)[0]
          cells = profiles[activeProfileId].cells
          app.debug(`polar-builder: loaded ${Object.keys(profiles).length} profile(s) from ${dataFile}`)
        } else {
          // v1 file: a single bare cell list, no profiles - migrate in place
          // and save immediately so a read-only session doesn't leave a
          // stale v1 file on disk indefinitely.
          profiles = { default: makeProfile('default') }
          profiles.default.cells = new Map(parsed.cells || [])
          activeProfileId = 'default'
          cells = profiles.default.cells
          app.debug(`polar-builder: migrated ${cells.size} cells from legacy single-table format`)
          dirty = true
          saveToDisk()
        }
      }
    } catch (e) {
      app.error(`polar-builder: failed to load stored polar data: ${e.message}`)
      profiles = { default: makeProfile('default') }
      activeProfileId = 'default'
      cells = profiles.default.cells
    }
  }

  function saveToDisk () {
    if (!dirty) return
    try {
      const tmp = dataFile + '.tmp'
      const payload = {
        version: 2,
        savedAt: new Date().toISOString(),
        activeProfile: activeProfileId,
        options: {
          twsBucketSize: options.twsBucketSize,
          twaBucketSize: options.twaBucketSize
        },
        profiles: {}
      }
      Object.keys(profiles).forEach((id) => {
        const p = profiles[id]
        payload.profiles[id] = {
          name: p.name,
          createdAt: p.createdAt,
          lastUpdated: p.lastUpdated,
          cells: Array.from(p.cells.entries())
        }
      })
      fs.writeFileSync(tmp, JSON.stringify(payload))
      fs.renameSync(tmp, dataFile)
      dirty = false
      app.debug(`polar-builder: saved ${Object.keys(profiles).length} profile(s) to ${dataFile}`)
    } catch (e) {
      app.error(`polar-builder: failed to save polar data: ${e.message}`)
    }
  }

  // ---- matrix / export helpers ------------------------------------------

  function buildMatrix (usePercentile, cellsMap) {
    const source = cellsMap || cells
    const twsSet = new Set()
    const twaSet = new Set()
    source.forEach((c) => {
      twsSet.add(c.tws)
      twaSet.add(c.twa)
    })
    const twsList = Array.from(twsSet).sort((a, b) => a - b)
    const twaList = Array.from(twaSet).sort((a, b) => a - b)

    const rows = twaList.map((twa) => {
      const row = { twa, speeds: {} }
      twsList.forEach((tws) => {
        const cell = source.get(cellKey(tws, twa))
        if (!cell) {
          row.speeds[tws] = null
        } else {
          row.speeds[tws] = usePercentile
            ? round(percentile(cell.samples, options.percentile), 2)
            : round(cell.avgBsp, 2)
        }
      })
      return row
    })

    return { tws: twsList, twa: twaList, rows }
  }

  // ---- performance-data interpolation (ported from public/index.html's
  // buildCurve/vmgScore/bestVmgPoint - same math, server-side, used to
  // publish live performance.* deltas rather than draw the webapp chart) --

  function buildCurve (twsList, rows, twsTarget) {
    if (!twsList.length) return { points: [], clamped: null }
    let clamped = null
    let target = twsTarget
    if (target < twsList[0]) { clamped = twsList[0]; target = twsList[0] }
    else if (target > twsList[twsList.length - 1]) { clamped = twsList[twsList.length - 1]; target = twsList[twsList.length - 1] }

    let lo = twsList[0]
    let hi = twsList[twsList.length - 1]
    for (let i = 0; i < twsList.length; i++) {
      if (twsList[i] <= target) lo = twsList[i]
      if (twsList[i] >= target) { hi = twsList[i]; break }
    }
    const frac = hi === lo ? 0 : (target - lo) / (hi - lo)

    const points = rows.map((row) => {
      const a = row.speeds[lo]
      const b = row.speeds[hi]
      if (a === null || a === undefined || b === null || b === undefined) return { twa: row.twa, bsp: null }
      return { twa: row.twa, bsp: a + (b - a) * frac }
    })
    return { points, clamped }
  }

  // Same bracket/clamp/lerp pattern as buildCurve, applied to the TWA axis
  // of the points array buildCurve already produced - composing the two is
  // a full TWS x TWA bilinear interpolation without any new matrix-walking
  // code, and null (missing-cell) propagation falls out for free.
  function interpolateAtTwa (points, twaTarget) {
    if (!points.length) return null
    const sorted = points.slice().sort((a, b) => a.twa - b.twa)
    let target = twaTarget
    if (target < sorted[0].twa) target = sorted[0].twa
    else if (target > sorted[sorted.length - 1].twa) target = sorted[sorted.length - 1].twa

    let lo = sorted[0]
    let hi = sorted[sorted.length - 1]
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].twa <= target) lo = sorted[i]
      if (sorted[i].twa >= target) { hi = sorted[i]; break }
    }
    if (lo.bsp == null || hi.bsp == null) return null
    const frac = hi.twa === lo.twa ? 0 : (target - lo.twa) / (hi.twa - lo.twa)
    return lo.bsp + (hi.bsp - lo.bsp) * frac
  }

  // The signed VMG convention used for reported values (positive=upwind,
  // negative=downwind, per the Signal K spec's velocityMadeGood
  // description) - distinct from vmgScore below, which flips sign for
  // downwind searches only so bestVmgPoint can maximize in one direction.
  function rawVmgKt (twaDeg, bspKt) {
    return bspKt * Math.cos(degToRad(twaDeg))
  }

  function vmgScore (twa, bsp, upwind) {
    const rad = degToRad(twa)
    return upwind ? bsp * Math.cos(rad) : -bsp * Math.cos(rad)
  }

  function bestVmgPoint (points, loAngle, hiAngle, upwind) {
    let best = null
    let bestScore = -Infinity
    points.forEach((p) => {
      if (p.bsp == null || p.twa < loAngle || p.twa > hiAngle) return
      const score = vmgScore(p.twa, p.bsp, upwind)
      if (score > bestScore) { bestScore = score; best = p }
    })
    return best
  }

  // Unlike the webapp (which shows both tacks' laylines at once), only the
  // current tack's beat/gybe angle is needed here. Unsigned matrices only
  // carry magnitude, so the found angle is mirrored to match the current
  // TWA's sign; signed matrices already carry the right-side data directly.
  function computeBeatGybe (points, twaSigned, useSignedTwa) {
    const sign = Math.sign(normalizeAngleDeg(twaSigned)) || 1
    const beatRange = useSignedTwa ? (sign > 0 ? [0, 90] : [-90, 0]) : [0, 90]
    const gybeRange = useSignedTwa ? (sign > 0 ? [90, 180] : [-180, -90]) : [90, 180]
    let beat = bestVmgPoint(points, beatRange[0], beatRange[1], true)
    let gybe = bestVmgPoint(points, gybeRange[0], gybeRange[1], false)
    if (!useSignedTwa) {
      if (beat) beat = { twa: beat.twa * sign, bsp: beat.bsp }
      if (gybe) gybe = { twa: gybe.twa * sign, bsp: gybe.bsp }
    }
    return { beat, gybe }
  }

  function matrixToDelimited (matrix, delim) {
    const header = ['TWA\\TWS'].concat(matrix.tws.map(String))
    const lines = [header.join(delim)]
    matrix.rows.forEach((row) => {
      const vals = matrix.tws.map((tws) => {
        const v = row.speeds[tws]
        return v === null || v === undefined ? '' : v
      })
      lines.push([row.twa].concat(vals).join(delim))
    })
    return lines.join('\n')
  }

  function matrixToCsv (matrix) {
    return matrixToDelimited(matrix, ',')
  }

  // Parses a TWA(rows) x TWS(columns) matrix back into {twa, tws, bsp}
  // points - the common "ORC-style" polar table shape, delimiter sniffed
  // (tab if the header line has one, else comma) rather than trusted from
  // a format flag, since real-world .pol/.csv files vary in the wild.
  function parseDelimitedMatrix (text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    const delim = lines[0].indexOf('\t') !== -1 ? '\t' : ','
    const header = lines[0].split(delim)
    const twsCols = header.slice(1).map((v) => parseFloat(v))
    const points = []
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(delim)
      const twa = parseFloat(parts[0])
      if (!isFinite(twa)) continue
      for (let j = 1; j < parts.length; j++) {
        const tws = twsCols[j - 1]
        const bsp = parseFloat(parts[j])
        if (!isFinite(tws) || !isFinite(bsp)) continue
        points.push({ twa, tws, bsp })
      }
    }
    return points
  }

  // ---- Signal K plugin lifecycle ----------------------------------------

  plugin.schema = {
    type: 'object',
    properties: {
      speedSource: {
        type: 'string',
        title: 'Boat speed source',
        enum: ['navigation.speedThroughWater', 'navigation.speedOverGround'],
        default: 'navigation.speedThroughWater'
      },
      windAngleSource: {
        type: 'string',
        title: 'True wind angle source',
        enum: ['environment.wind.angleTrueWater', 'environment.wind.angleTrueGround'],
        default: 'environment.wind.angleTrueWater'
      },
      useSignedTwa: {
        type: 'boolean',
        title: 'Use signed TWA (keep port/starboard separate) instead of folding to 0-180 deg',
        default: false
      },
      engineRpmThreshold: {
        type: 'number',
        title: 'Treat engine as running above this speed (RPM) - checked in addition to propulsion.*.state',
        default: 100
      },
      twsBucketSize: {
        type: 'number',
        title: 'TWS bucket size (knots)',
        default: 2
      },
      twaBucketSize: {
        type: 'number',
        title: 'TWA bucket size (degrees)',
        default: 5
      },
      stabilityWindowSeconds: {
        type: 'number',
        title: 'Stability analysis window (seconds)',
        description: 'How much recent history is examined to decide whether conditions are steady.',
        default: 12
      },
      sampleIntervalSeconds: {
        type: 'number',
        title: 'Minimum seconds between recorded samples while stable',
        default: 8
      },
      maxSpeedStdDev: {
        type: 'number',
        title: 'Max boat-speed std-dev within window (knots) to count as stable',
        default: 0.3
      },
      maxTwsStdDev: {
        type: 'number',
        title: 'Max TWS std-dev within window (knots) to count as stable',
        default: 0.7
      },
      maxTwaStdDev: {
        type: 'number',
        title: 'Max TWA std-dev within window (degrees) to count as stable',
        default: 4
      },
      maxRateOfTurn: {
        type: 'number',
        title: 'Max |rate of turn| (deg/s) to count as stable',
        default: 3
      },
      minTws: {
        type: 'number',
        title: 'Ignore samples below this TWS (knots)',
        default: 2
      },
      maxTws: {
        type: 'number',
        title: 'Ignore samples above this TWS (knots)',
        default: 40
      },
      minBsp: {
        type: 'number',
        title: 'Ignore samples below this boat speed (knots) - filters out moored/anchored data',
        default: 0.3
      },
      samplesPerCell: {
        type: 'number',
        title: 'Max recent samples retained per cell (used for percentile calc)',
        default: 50
      },
      percentile: {
        type: 'number',
        title: 'Percentile used for the reported polar speed (filters out helming errors)',
        default: 90
      },
      persistIntervalSeconds: {
        type: 'number',
        title: 'How often to save the polar table to disk (seconds)',
        default: 30
      },
      publishPerformanceData: {
        type: 'boolean',
        title: 'Publish live performance.* Signal K deltas (VMG, target speed, beat/gybe angle) computed from the polar table',
        default: true
      },
      performanceDampingSeconds: {
        type: 'number',
        title: 'Damping time constant (seconds) for the TWS used to look up published performance data - separate from the webapp\'s own damping slider',
        default: 15
      }
    }
  }

  plugin.start = function (opts) {
    options = Object.assign(
      {
        speedSource: 'navigation.speedThroughWater',
        windAngleSource: 'environment.wind.angleTrueWater',
        useSignedTwa: false,
        engineRpmThreshold: 100,
        twsBucketSize: 2,
        twaBucketSize: 5,
        stabilityWindowSeconds: 12,
        sampleIntervalSeconds: 8,
        maxSpeedStdDev: 0.3,
        maxTwsStdDev: 0.7,
        maxTwaStdDev: 4,
        maxRateOfTurn: 3,
        minTws: 2,
        maxTws: 40,
        minBsp: 0.3,
        samplesPerCell: 50,
        percentile: 90,
        persistIntervalSeconds: 30,
        publishPerformanceData: true,
        performanceDampingSeconds: 15
      },
      opts || {}
    )

    const dataDir = app.getDataDirPath ? app.getDataDirPath() : path.join(__dirname, 'data')
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    dataFile = path.join(dataDir, 'polars.json')

    loadFromDisk()

    const subscription = {
      context: 'vessels.self',
      subscribe: [
        { path: options.speedSource, period: 1000 },
        { path: 'environment.wind.speedTrue', period: 1000 },
        { path: options.windAngleSource, period: 1000 },
        { path: 'navigation.rateOfTurn', period: 1000 },
        { path: 'propulsion.*.revolutions', period: 1000 },
        { path: 'propulsion.*.state', period: 1000 },
        // Optional - only used if actually published on the bus. Heading
        // enables tackTrue/tackMagnetic; attitude (heel) is captured for
        // possible future use (see README - leeway isn't computed yet).
        { path: 'navigation.headingTrue', period: 1000 },
        { path: 'navigation.headingMagnetic', period: 1000 },
        { path: 'navigation.attitude', period: 1000 }
      ]
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err) => app.error(`polar-builder subscription error: ${err}`),
      (delta) => {
        const now = Date.now()
        ;(delta.updates || []).forEach((u) => {
          ;(u.values || []).forEach((v) => {
            if (v.value === null || v.value === undefined) return

            if (updateEngineFromPath(v.path, v.value, now)) {
              // handled - propulsion.* path
            } else if (v.path === options.speedSource) {
              const kt = v.value * MS_TO_KNOTS
              latest.bsp = kt
              latest.bspTime = now
              windows.bsp.push(now, kt)
            } else if (v.path === 'environment.wind.speedTrue') {
              const kt = v.value * MS_TO_KNOTS
              latest.tws = kt
              latest.twsTime = now
              windows.tws.push(now, kt)
              const dt = lastDampedTwsUpdate ? (now - lastDampedTwsUpdate) / 1000 : 0
              dampedTws = emaUpdate(dampedTws, kt, dt, options.performanceDampingSeconds)
              lastDampedTwsUpdate = now
            } else if (v.path === options.windAngleSource) {
              const deg = normalizeAngleDeg(radToDeg(v.value))
              latest.twa = deg
              latest.twaTime = now
              windows.twa.push(now, deg)
            } else if (v.path === 'navigation.rateOfTurn') {
              latest.rot = radToDeg(v.value)
              latest.rotTime = now
            } else if (v.path === 'navigation.headingTrue') {
              latest.headingTrue = v.value
              latest.headingTrueTime = now
            } else if (v.path === 'navigation.headingMagnetic') {
              latest.headingMagnetic = v.value
              latest.headingMagneticTime = now
            } else if (v.path === 'navigation.attitude') {
              if (v.value && typeof v.value.roll === 'number') {
                latest.heelRad = v.value.roll
                latest.heelTime = now
              }
            }
          })
        })
      }
    )

    stabilityTimer = setInterval(checkStability, 1000)
    persistTimer = setInterval(saveToDisk, options.persistIntervalSeconds * 1000)
    performanceTimer = setInterval(publishPerformance, 1000)

    app.setPluginStatus(`Started - ${cells.size} cells loaded from disk`)
  }

  plugin.stop = function () {
    if (stabilityTimer) clearInterval(stabilityTimer)
    if (persistTimer) clearInterval(persistTimer)
    if (performanceTimer) clearInterval(performanceTimer)
    stabilityTimer = null
    persistTimer = null
    performanceTimer = null
    saveToDisk()
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    app.setPluginStatus('Stopped')
  }

  // ---- REST API ----------------------------------------------------------

  plugin.registerWithRouter = function (router) {
    // ---- profiles ---------------------------------------------------

    router.get('/profiles', (req, res) => {
      res.json({
        active: activeProfileId,
        profiles: Object.keys(profiles).map((id) => ({
          id,
          name: profiles[id].name,
          cellCount: profiles[id].cells.size,
          createdAt: profiles[id].createdAt,
          lastUpdated: profiles[id].lastUpdated
        }))
      })
    })

    router.post('/profiles', (req, res) => {
      const name = req.body && req.body.name ? String(req.body.name).trim() : ''
      if (!name) return res.status(400).json({ error: 'name is required' })
      const id = slugify(name)
      if (!id) return res.status(400).json({ error: 'name produced an empty id' })
      if (profiles[id]) return res.status(409).json({ error: `profile '${id}' already exists` })
      profiles[id] = makeProfile(name)
      activateProfile(id)
      dirty = true
      saveToDisk()
      res.json({ ok: true, id, active: activeProfileId })
    })

    router.post('/profiles/:id/activate', (req, res) => {
      if (!activateProfile(req.params.id)) {
        return res.status(404).json({ error: `unknown profile '${req.params.id}'` })
      }
      res.json({ ok: true, active: activeProfileId })
    })

    router.delete('/profiles/:id', (req, res) => {
      const id = req.params.id
      if (!profiles[id]) return res.status(404).json({ error: `unknown profile '${id}'` })
      if (Object.keys(profiles).length <= 1) {
        return res.status(400).json({ error: 'cannot delete the only remaining profile' })
      }
      delete profiles[id]
      if (activeProfileId === id) {
        activateProfile(Object.keys(profiles).sort()[0])
      }
      dirty = true
      saveToDisk()
      res.json({ ok: true, active: activeProfileId })
    })

    // ---- polar data (all default to the active profile; ?profile=<id>
    // reads/writes a specific one without switching which is active) ----

    router.get('/polar.json', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      const source = target.profile.cells
      res.json({
        cellCount: source.size,
        options: {
          twsBucketSize: options.twsBucketSize,
          twaBucketSize: options.twaBucketSize,
          percentile: options.percentile
        },
        cells: Array.from(source.values()).map((c) => ({
          tws: c.tws,
          twa: c.twa,
          count: c.count,
          avgBsp: round(c.avgBsp, 2),
          maxBsp: round(c.maxBsp, 2),
          polarBsp: round(percentile(c.samples, options.percentile), 2),
          lastUpdated: c.lastUpdated
        }))
      })
    })

    // Dense matrix (TWS columns x TWA rows), using the percentile speed
    router.get('/polar/matrix', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      res.json(buildMatrix(true, target.profile.cells))
    })

    // Same matrix as CSV, e.g. for import into a chart or another VPP tool
    router.get('/polar/csv', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      const matrix = buildMatrix(true, target.profile.cells)
      res.type('text/csv').send(matrixToCsv(matrix))
    })

    // Same matrix, downloadable as CSV or tab-delimited .pol (the common
    // "ORC-style" polar table shape most routing tools accept)
    router.get('/polar/export', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      const format = req.query.format === 'pol' ? 'pol' : 'csv'
      const delim = format === 'pol' ? '\t' : ','
      const matrix = buildMatrix(true, target.profile.cells)
      const body = matrixToDelimited(matrix, delim)
      res.set('Content-Disposition', `attachment; filename="${target.id}-polar.${format}"`)
      res.type(format === 'pol' ? 'text/plain' : 'text/csv').send(body)
    })

    // Import a CSV or .pol TWA x TWS matrix into a profile. Body is read
    // manually (not via a body-parser) since the plugin has no npm
    // dependencies by design; delimiter is sniffed, not trusted from a flag.
    router.post('/polar/import', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      const mode = req.query.mode === 'merge' ? 'merge' : 'replace'
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let points
        try {
          points = parseDelimitedMatrix(body)
        } catch (e) {
          res.status(400).json({ error: `could not parse import: ${e.message}` })
          return
        }
        if (!points.length) {
          res.status(400).json({ error: 'no data points found in import' })
          return
        }
        const targetCells = target.profile.cells
        if (mode === 'replace') targetCells.clear()
        const now = Date.now()
        points.forEach((p) => {
          targetCells.set(cellKey(p.tws, p.twa), {
            tws: p.tws,
            twa: p.twa,
            count: 1,
            avgBsp: p.bsp,
            maxBsp: p.bsp,
            samples: [p.bsp],
            firstSeen: now,
            lastUpdated: now
          })
        })
        target.profile.lastUpdated = now
        dirty = true
        saveToDisk()
        res.json({ ok: true, imported: points.length, cellCount: targetCells.size })
      })
      req.on('error', (e) => res.status(400).json({ error: e.message }))
    })

    router.get('/polar/status', (req, res) => {
      res.json({
        cellCount: cells.size,
        activeProfile: activeProfileId,
        lastSampleTime,
        latest,
        engineRunning,
        engines
      })
    })

    router.get('/inputs', (req, res) => {
      res.json({ inputs: getInputsStatus() })
    })

    router.post('/polar/reset', (req, res) => {
      const target = resolveProfile(req)
      if (!target) return res.status(404).json({ error: `unknown profile '${req.query.profile}'` })
      target.profile.cells.clear()
      target.profile.lastUpdated = Date.now()
      dirty = true
      saveToDisk()
      res.json({ ok: true, cellCount: target.profile.cells.size })
    })
  }

  return plugin
}
