const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock, feed, kt, rad, BASE_12, sampleCsv } = require('../helpers/harness')

function near (actual, expected, msg, eps = 1e-6) {
  assert.equal(typeof actual, 'number', `${msg}: expected a number, got ${actual}`)
  assert.ok(Math.abs(actual - expected) < eps, `${msg}: expected ~${expected}, got ${actual}`)
}

const sailing = (bspKt, twaDeg, twsKt = 12, extra = {}) => Object.assign({
  'navigation.speedThroughWater': kt(bspKt),
  'environment.wind.speedTrue': kt(twsKt),
  'environment.wind.angleTrueWater': rad(twaDeg)
}, extra)

async function setup (t, options) {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start(options || {})
  assert.equal((await h.importCsv(sampleCsv())).body.ok, true)
  return h
}

test('upwind: publishes polar speed, ratio, beat/gybe values and the upwind target', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45))
  const p = h.published

  const vmgActual = 4.8 * Math.cos(rad(45))
  near(p['performance.velocityMadeGood'], kt(vmgActual), 'velocityMadeGood')
  near(p['performance.polarSpeed'], kt((BASE_12[40] + BASE_12[50]) / 2), 'polarSpeed interpolated between 40 and 50 deg')
  near(p['performance.polarSpeedRatio'], 4.8 / ((BASE_12[40] + BASE_12[50]) / 2), 'polarSpeedRatio')

  near(p['performance.beatAngle'], rad(40), 'beatAngle is the best-VMG upwind row')
  near(p['performance.beatAngleTargetSpeed'], kt(BASE_12[40]), 'beatAngleTargetSpeed')
  near(p['performance.beatAngleVelocityMadeGood'], kt(BASE_12[40] * Math.cos(rad(40))), 'beatAngleVelocityMadeGood')
  near(p['performance.gybeAngle'], rad(150), 'gybeAngle is the best-VMG downwind row')
  near(p['performance.gybeAngleTargetSpeed'], kt(BASE_12[150]), 'gybeAngleTargetSpeed')

  near(p['performance.targetAngle'], rad(40), 'targetAngle follows the beat angle upwind')
  near(p['performance.targetSpeed'], kt(BASE_12[40]), 'targetSpeed follows the beat target upwind')
})

test('downwind: the target switches to the gybe values and VMG is negative', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(6.0, 150))
  const p = h.published
  assert.ok(p['performance.velocityMadeGood'] < 0)
  near(p['performance.targetAngle'], rad(150), 'targetAngle follows the gybe angle downwind')
  near(p['performance.targetSpeed'], kt(BASE_12[150]), 'targetSpeed follows the gybe target downwind')
})

test('velocityMadeGoodRatio is actual VMG over the polar best VMG, 1.0 = 100%', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45))
  const upwindRatio = (4.8 * Math.cos(rad(45))) / (BASE_12[40] * Math.cos(rad(40)))
  near(h.published['performance.velocityMadeGoodRatio'], upwindRatio, 'upwind ratio')

  h.clearPublished()
  feed(t, h, 3, sailing(6.0, 150))
  const downwindRatio = (6.0 * Math.cos(rad(150))) / (BASE_12[150] * Math.cos(rad(150)))
  near(h.published['performance.velocityMadeGoodRatio'], downwindRatio, 'downwind ratio is positive too')
})

test('velocityMadeGoodRatio never goes negative', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(-1.0, 45))
  const ratio = h.published['performance.velocityMadeGoodRatio']
  assert.equal(ratio, 0)
})

test('optimumWindAngle is target TWA minus current TWA, on the boat\'s own tack side', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45))
  near(h.published['performance.optimumWindAngle'], rad(40 - 45), 'starboard tack')

  h.clearPublished()
  feed(t, h, 3, sailing(4.8, -45))
  near(h.published['performance.beatAngle'], rad(-40), 'port-tack beat angle is mirrored')
  near(h.published['performance.optimumWindAngle'], rad(-40 - -45), 'port tack')

  h.clearPublished()
  feed(t, h, 3, sailing(5.6, 40))
  near(h.published['performance.optimumWindAngle'], 0, 'on target is zero')
})

test('tack heading is published when true heading is on the bus', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45, 12, { 'navigation.headingTrue': 0.5 }))
  near(h.published['performance.tackTrue'], 0.5 + 2 * rad(45), 'tackTrue = heading + 2*TWA')
})

test('no tack heading without a heading source', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45))
  assert.equal(h.published['performance.tackTrue'], undefined)
  assert.equal(h.published['performance.tackMagnetic'], undefined)
})

test('with an empty polar only the VMG is published, not polar-derived values', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 3, sailing(4.8, 45))
  assert.ok(typeof h.published['performance.velocityMadeGood'] === 'number')
  ;['polarSpeed', 'polarSpeedRatio', 'beatAngle', 'gybeAngle', 'targetSpeed', 'targetAngle', 'velocityMadeGoodRatio', 'optimumWindAngle']
    .forEach((name) => assert.equal(h.published['performance.' + name], undefined, name))
})

test('stale inputs stop the publishing', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, 45))
  assert.ok(h.published['performance.velocityMadeGood'] !== undefined)
  t.mock.timers.tick(15000) // no new data for 15 s - older than the 10 s staleness limit
  h.clearPublished()
  t.mock.timers.tick(1000)
  assert.deepEqual(h.published, {})
})

test('publishPerformanceData: false publishes nothing at all', async (t) => {
  const h = await setup(t, { publishPerformanceData: false, enableMfdDisplay: true })
  feed(t, h, 3, sailing(4.8, 45))
  assert.deepEqual(h.published, {})
})

test('the MFD tile marker is not published by default', async (t) => {
  const h = await setup(t)
  feed(t, h, 2, sailing(4.8, 45))
  assert.equal(h.published['performance.mfdDisplayEnabled'], undefined)
})

test('enableMfdDisplay publishes the marker the MFD tile looks for', async (t) => {
  const h = await setup(t, { enableMfdDisplay: true })
  feed(t, h, 2, sailing(4.8, 45))
  assert.equal(h.published['performance.mfdDisplayEnabled'], true)
})

test('polar speed on port tack reads the same table as starboard (unsigned polar)', async (t) => {
  const h = await setup(t)
  feed(t, h, 3, sailing(4.8, -45))
  near(h.published['performance.polarSpeed'], kt((BASE_12[40] + BASE_12[50]) / 2), 'polarSpeed on port tack')
})
