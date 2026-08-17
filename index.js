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
  let options = {}
  let dataFile = null

  let latest = {
    tws: null, // knots
    twa: null, // degrees, signed -180..180
    bsp: null, // knots
    rot: null, // deg/s
    twsTime: 0,
    twaTime: 0,
    bspTime: 0,
    rotTime: 0
  }

  let lastSampleTime = 0

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
        persistIntervalSeconds: 30
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
        { path: 'propulsion.*.state', period: 1000 }
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
            } else if (v.path === options.windAngleSource) {
              const deg = normalizeAngleDeg(radToDeg(v.value))
              latest.twa = deg
              latest.twaTime = now
              windows.twa.push(now, deg)
            } else if (v.path === 'navigation.rateOfTurn') {
              latest.rot = radToDeg(v.value)
            }
          })
        })
      }
    )

    stabilityTimer = setInterval(checkStability, 1000)
    persistTimer = setInterval(saveToDisk, options.persistIntervalSeconds * 1000)

    app.setPluginStatus(`Started - ${cells.size} cells loaded from disk`)
  }

  plugin.stop = function () {
    if (stabilityTimer) clearInterval(stabilityTimer)
    if (persistTimer) clearInterval(persistTimer)
    stabilityTimer = null
    persistTimer = null
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
