const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock, feed, kt, rad, BASE_12, sampleCsv } = require('../helpers/harness')

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const sailing = (bspKt, twaDeg, twsKt = 12) => ({
  'navigation.speedThroughWater': kt(bspKt),
  'environment.wind.speedTrue': kt(twsKt),
  'environment.wind.angleTrueWater': rad(twaDeg)
})

const POLAR_PATHS = ['polarSpeed', 'polarSpeedRatio', 'beatAngle', 'beatAngleTargetSpeed', 'gybeAngle', 'targetSpeed', 'targetAngle', 'velocityMadeGoodRatio', 'optimumWindAngle']

async function setup (t, options, csv) {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start(options || {})
  assert.equal((await h.importCsv(csv || sampleCsv())).body.ok, true)
  return h
}

function assertNoPolarValues (h) {
  POLAR_PATHS.forEach((name) => assert.equal(h.published['performance.' + name], undefined, name))
}

// ---- coverage guard: don't publish extrapolations as polar data ------------

test('TWS far above the recorded table publishes VMG but no polar-derived values', async (t) => {
  const h = await setup(t) // table covers 8-16 kt
  feed(t, h, 3, sailing(6, 45, 25))
  assert.ok(typeof h.published['performance.velocityMadeGood'] === 'number')
  assertNoPolarValues(h)
})

test('TWS far below the recorded table publishes no polar-derived values', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(2, 45, 3))
  assertNoPolarValues(h)
})

test('TWS within one bucket of the table edge still uses the edge column', async (t) => {
  const h = await setup(t, { twsBucketSize: 2 })
  feed(t, h, 3, sailing(6, 45, 17.5))
  assert.ok(typeof h.published['performance.polarSpeed'] === 'number')
})

test('TWA outside the recorded rows drops polarSpeed/ratio but keeps beat, gybe and target values', async (t) => {
  const h = await setup(t) // lowest row 35 deg, margin one 5 deg bucket
  feed(t, h, 3, sailing(2, 10))
  assert.equal(h.published['performance.polarSpeed'], undefined)
  assert.equal(h.published['performance.polarSpeedRatio'], undefined)
  assert.ok(typeof h.published['performance.beatAngle'] === 'number')
  assert.ok(typeof h.published['performance.targetSpeed'] === 'number')
})

test('a signed table with only starboard rows publishes no polar speed on port tack', async (t) => {
  const h = await setup(t, { useSignedTwa: true })
  feed(t, h, 3, sailing(4.8, 45))
  assert.ok(typeof h.published['performance.polarSpeed'] === 'number')
  h.clearPublished()
  feed(t, h, 3, sailing(4.8, -45))
  assert.equal(h.published['performance.polarSpeed'], undefined)
})

// ---- performance.activePolar / activePolarData (Signal K spec shapes) ------

test('activePolar is the active profile\'s v4 UUID, also shown in /profiles', async (t) => {
  const h = await setup(t)
  feed(t, h, 2, sailing(4.8, 45))
  const uuid = h.published['performance.activePolar']
  assert.match(uuid, UUID_V4)
  const active = (await h.get('/profiles')).body.profiles.find((p) => p.id === 'default')
  assert.equal(active.uuid, uuid)
})

test('activePolarData follows the spec: keyed by uuid, rad and m/s, optimal beat/gybe per wind speed', async (t) => {
  const h = await setup(t)
  feed(t, h, 2, sailing(4.8, 45))
  const uuid = h.published['performance.activePolar']
  const polar = h.published['performance.activePolarData'][uuid]
  assert.equal(polar.id, uuid)
  assert.equal(polar.name, 'default')
  assert.deepEqual(polar.windData.map((w) => Math.round(w.trueWindSpeed * 1.9438444924574)), [8, 12, 16], 'one entry per recorded wind speed, in m/s')

  const col12 = polar.windData[1]
  assert.equal(col12.angleData.length, Object.keys(BASE_12).length)
  Object.keys(BASE_12).forEach((twa, i) => {
    assert.ok(Math.abs(col12.angleData[i][0] - rad(Number(twa))) < 1e-9, `angle ${twa}`)
    assert.ok(Math.abs(col12.angleData[i][1] - kt(BASE_12[twa])) < 1e-6, `speed at ${twa}`)
  })
  assert.equal(col12.optimalBeats.length, 1, 'one element for a symmetric table')
  assert.ok(Math.abs(col12.optimalBeats[0][0] - rad(40)) < 1e-9)
  assert.ok(Math.abs(col12.optimalBeats[0][1] - kt(BASE_12[40])) < 1e-6)
  assert.ok(Math.abs(col12.optimalGybes[0][0] - rad(150)) < 1e-9)
})

test('a signed table gets two optimal beats and gybes (starboard, port)', async (t) => {
  const csv = 'TWA\\TWS,12\n-150,6.2\n-40,5.6\n-35,5.0\n35,5.0\n40,5.6\n150,6.2'
  const h = await setup(t, { useSignedTwa: true }, csv)
  feed(t, h, 2, sailing(4.8, 45))
  const uuid = h.published['performance.activePolar']
  const w = h.published['performance.activePolarData'][uuid].windData[0]
  assert.deepEqual(w.optimalBeats.map((b) => Math.round(b[0] / rad(1))), [40, -40])
  assert.deepEqual(w.optimalGybes.map((g) => Math.round(g[0] / rad(1))), [150, -150])
})

test('an empty table publishes the uuid but null data', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 2, sailing(4.8, 45))
  assert.match(h.published['performance.activePolar'], UUID_V4)
  assert.equal(h.published['performance.activePolarData'], null)
})

test('the polar is republished on a profile switch at once, and on data changes at most every 30 s', async (t) => {
  const h = await setup(t)
  feed(t, h, 2, sailing(4.8, 45))
  assert.ok(h.published['performance.activePolarData'])

  h.clearPublished()
  feed(t, h, 5, sailing(4.8, 45))
  assert.equal(h.published['performance.activePolar'], undefined, 'unchanged: not republished')

  await h.importCsv('TWA\\TWS,12\n40,9.9', '?mode=merge')
  feed(t, h, 10, sailing(4.8, 45))
  assert.equal(h.published['performance.activePolar'], undefined, 'changed, but inside the 30 s window')
  feed(t, h, 25, sailing(4.8, 45))
  assert.match(h.published['performance.activePolar'], UUID_V4, 'republished after the window')

  const before = h.published['performance.activePolar']
  h.clearPublished()
  await h.post('/profiles', { name: 'second' })
  feed(t, h, 1, sailing(4.8, 45))
  assert.match(h.published['performance.activePolar'], UUID_V4)
  assert.notEqual(h.published['performance.activePolar'], before)
  assert.equal(h.published['performance.activePolarData'], null, 'the new profile is empty')
})

test('profile uuids are unique and survive a restart', async (t) => {
  useClock(t)
  const first = createHarness()
  first.start({})
  await first.post('/profiles', { name: 'other' })
  const uuids = (await first.get('/profiles')).body.profiles.map((p) => p.uuid)
  assert.equal(new Set(uuids).size, 2)
  uuids.forEach((u) => assert.match(u, UUID_V4))
  first.plugin.stop()

  const second = createHarness({ dataDir: first.dir })
  t.after(() => second.stop())
  second.start({})
  assert.deepEqual((await second.get('/profiles')).body.profiles.map((p) => p.uuid), uuids)
})

test('publishPerformanceData: false also stops the polar from being published', async (t) => {
  const h = await setup(t, { publishPerformanceData: false })
  feed(t, h, 3, sailing(4.8, 45))
  assert.equal(h.published['performance.activePolar'], undefined)
})
