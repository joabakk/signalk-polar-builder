const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock, feed, kt, rad } = require('../helpers/harness')

const steady = (bspKt, twaDeg = 40, twsKt = 12) => ({
  'navigation.speedThroughWater': kt(bspKt),
  'environment.wind.speedTrue': kt(twsKt),
  'environment.wind.angleTrueWater': rad(twaDeg)
})

async function cellCount (h) {
  return (await h.get('/polar/status')).body.cellCount
}

test('steady sailing with the engine off records a cell in the right bucket', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 40, steady(6.0))
  assert.ok(await cellCount(h) >= 1)

  const cell = (await h.get('/polar.json')).body.cells[0]
  assert.equal(cell.tws, 12)
  assert.equal(cell.twa, 40)
  assert.ok(Math.abs(cell.avgBsp - 6.0) < 0.01)
})

test('nothing is recorded before a full stability window has passed', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 8, steady(6.0))
  assert.equal(await cellCount(h), 0)
})

test('nothing is recorded while the engine is running', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.main.state', 'started')
  feed(t, h, 40, steady(6.0))
  assert.equal(await cellCount(h), 0)
  assert.match(h.app.status, /Engine running/)
})

test('after the engine stops, recording waits a full window before resuming', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.main.state', 'started')
  feed(t, h, 30, steady(6.0))
  h.emit('propulsion.main.state', 'stopped')
  feed(t, h, 6, steady(6.0))
  assert.equal(await cellCount(h), 0)
  assert.match(h.app.status, /recently stopped/)
  feed(t, h, 30, steady(6.0))
  assert.ok(await cellCount(h) >= 1)
})

test('unsteady boat speed is not recorded', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  for (let i = 0; i < 40; i++) {
    const bsp = i % 2 === 0 ? 3.0 : 7.0
    feed(t, h, 1, steady(bsp))
  }
  assert.equal(await cellCount(h), 0)
})

test('a high rate of turn blocks recording', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({ maxRateOfTurn: 3 })
  feed(t, h, 40, Object.assign(steady(6.0), { 'navigation.rateOfTurn': rad(10) }))
  assert.equal(await cellCount(h), 0)
})

test('wind outside minTws/maxTws is ignored', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({ minTws: 2, maxTws: 40 })
  feed(t, h, 40, steady(2.0, 40, 1))
  assert.equal(await cellCount(h), 0)
})

test('unsigned TWA folds port and starboard into the same cell; signed keeps them apart', async (t) => {
  useClock(t)
  const unsigned = createHarness()
  t.after(() => unsigned.stop())
  unsigned.start({ useSignedTwa: false })
  feed(t, unsigned, 40, steady(6.0, -40))
  assert.equal((await unsigned.get('/polar.json')).body.cells[0].twa, 40)

  const signed = createHarness()
  t.after(() => signed.stop())
  signed.start({ useSignedTwa: true })
  feed(t, signed, 40, steady(6.0, -40))
  assert.equal((await signed.get('/polar.json')).body.cells[0].twa, -40)
})

test('recorded cells survive a restart (persisted to disk on stop)', async (t) => {
  useClock(t)
  const first = createHarness()
  first.start({})
  feed(t, first, 40, steady(6.0))
  const count = await cellCount(first)
  assert.ok(count >= 1)
  first.plugin.stop()

  const second = createHarness({ dataDir: first.dir })
  t.after(() => second.stop())
  second.start({})
  assert.equal(await cellCount(second), count)
})
