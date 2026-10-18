const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock, feed, kt, rad } = require('../helpers/harness')

const sailing = (extra) => Object.assign({
  'navigation.speedThroughWater': kt(6),
  'environment.wind.speedTrue': kt(12),
  'environment.wind.angleTrueWater': rad(40)
}, extra || {})

async function diagnostics (h) {
  return (await h.get('/polar/status')).body.diagnostics
}

test('minBsp defaults to 1 kt, so a boat at a dock is not recorded', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  assert.equal(h.plugin.schema.properties.minBsp.default, 1)
  h.start({})
  feed(t, h, 40, { 'navigation.speedThroughWater': kt(0.35), 'environment.wind.speedTrue': kt(4), 'environment.wind.angleTrueWater': rad(-30) })
  assert.equal((await h.get('/polar/status')).body.cellCount, 0)
  const d = await diagnostics(h)
  assert.ok(d.blockedBy.range > 0)
  assert.match(d.last.text, /outside the recording range/)
})

test('steady sailing is counted as recorded/waiting and the last state is stable', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 40, sailing())
  const d = await diagnostics(h)
  assert.ok(d.counts.recorded >= 1)
  assert.ok(d.counts.waiting >= 1)
  assert.ok(['recorded', 'waiting'].includes(d.last.reason))
  assert.equal(d.last.fails.length, 0)
  assert.equal(d.last.text, null)
})

test('the first window after start is engine-settling, then no data means too-little-data', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 5, sailing())
  assert.equal((await diagnostics(h)).last.reason, 'engine-settling')
  t.mock.timers.tick(20000) // past the settling window, with no wind/speed data arriving
  assert.equal((await diagnostics(h)).last.reason, 'too-little-data')
})

test('the engine running is reported as the reason', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.main.state', 'started')
  feed(t, h, 20, sailing())
  const d = await diagnostics(h)
  assert.equal(d.last.reason, 'engine')
  assert.equal(d.counts.engine, 20)
})

test('just after the engine stops the reason is engine-settling', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.main.state', 'started')
  feed(t, h, 20, sailing())
  h.emit('propulsion.main.state', 'stopped')
  feed(t, h, 3, sailing())
  assert.equal((await diagnostics(h)).last.reason, 'engine-settling')
})

test('a noisy TWA alone is reported as the only blocker, with its spread and the limit', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({ maxTwaStdDev: 4 })
  for (let i = 0; i < 40; i++) {
    feed(t, h, 1, sailing({ 'environment.wind.angleTrueWater': rad(40 + (i % 2 === 0 ? 9 : -9)) }))
  }
  const d = await diagnostics(h)
  assert.equal(d.last.reason, 'blocked')
  assert.deepEqual(d.last.fails, ['twa'])
  assert.ok(d.onlyBlockedBy.twa > 0)
  assert.equal(d.onlyBlockedBy.tws, 0)
  assert.ok(d.spread.twaStd.median > 4, 'the typical TWA spread is above the limit')
  assert.equal(d.limits.maxTwaStdDev, 4)
  assert.match(d.last.text, /TWA \+\/-[\d.]+deg > 4/)
  assert.match(h.app.status, /not stable: TWA/)
  assert.equal((await h.get('/polar/status')).body.cellCount, 0)
})

test('relaxing the limit that was the only blocker lets the same data record', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({ maxTwaStdDev: 12 })
  for (let i = 0; i < 40; i++) {
    feed(t, h, 1, sailing({ 'environment.wind.angleTrueWater': rad(40 + (i % 2 === 0 ? 9 : -9)) }))
  }
  assert.ok((await h.get('/polar/status')).body.cellCount >= 1)
})

test('several failing criteria are all counted, but not as "only"', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  for (let i = 0; i < 30; i++) {
    feed(t, h, 1, {
      'navigation.speedThroughWater': kt(i % 2 === 0 ? 3 : 8),
      'environment.wind.speedTrue': kt(i % 2 === 0 ? 8 : 16),
      'environment.wind.angleTrueWater': rad(40 + (i % 2 === 0 ? 9 : -9))
    })
  }
  const d = await diagnostics(h)
  assert.ok(d.blockedBy.speed > 0 && d.blockedBy.tws > 0 && d.blockedBy.twa > 0)
  assert.equal(d.onlyBlockedBy.speed + d.onlyBlockedBy.tws + d.onlyBlockedBy.twa, 0)
})

test('the diagnostics cover the last hour only', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  feed(t, h, 3700, sailing())
  assert.equal((await diagnostics(h)).seconds, 3600)
})
