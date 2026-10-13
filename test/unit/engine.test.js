const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock } = require('../helpers/harness')

async function engineRunning (h) {
  return (await h.get('/polar/status')).body.engineRunning
}

test('no engine data means the engine is not running', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  assert.equal(await engineRunning(h), false)
})

test('propulsion.*.state other than "stopped" means running', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.main.state', 'started')
  assert.equal(await engineRunning(h), true)
  h.emit('propulsion.main.state', 'stopped')
  assert.equal(await engineRunning(h), false)
})

test('propulsion RPM at or above the threshold means running (Hz on the bus)', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({ engineRpmThreshold: 100 })
  h.emit('propulsion.port.revolutions', 50 / 60) // 50 rpm
  assert.equal(await engineRunning(h), false)
  h.emit('propulsion.port.revolutions', 1200 / 60) // 1200 rpm
  assert.equal(await engineRunning(h), true)
})

test('any one of several engines running is enough', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  h.emit('propulsion.port.state', 'stopped')
  h.emit('propulsion.starboard.state', 'started')
  assert.equal(await engineRunning(h), true)
})

test('engineVoltageSource is not subscribed and has no input row when unset', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  assert.ok(!h.app.subscription.subscribe.some((s) => s.path.startsWith('electrical.')))
  const inputs = (await h.get('/inputs')).body.inputs
  assert.ok(!inputs.some((i) => i.id === 'engineVoltage'))
})

test('a configured path at/above its threshold means running, below means stopped', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  const source = 'electrical.alternator.277.current'
  h.start({ engineVoltageSource: source, engineVoltageThreshold: 1 })
  assert.ok(h.app.subscription.subscribe.some((s) => s.path === source))

  h.emit(source, 0)
  assert.equal(await engineRunning(h), false)
  h.emit(source, 8.5)
  assert.equal(await engineRunning(h), true)
  h.emit(source, 0)
  assert.equal(await engineRunning(h), false)
})

test('the configured path appears in the inputs list with its reading', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  const source = 'electrical.alternator.277.current'
  h.start({ engineVoltageSource: source, engineVoltageThreshold: 1 })
  h.emit(source, 12.6)
  const row = (await h.get('/inputs')).body.inputs.find((i) => i.id === 'engineVoltage')
  assert.ok(row)
  assert.equal(row.path, source)
  assert.equal(row.active, true)
  assert.equal(row.display, '12.6')
  assert.equal(row.required, false)
})

test('the configured path is OR-ed with propulsion data, not a replacement', async (t) => {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  const source = 'electrical.alternator.277.current'
  h.start({ engineVoltageSource: source, engineVoltageThreshold: 1 })
  h.emit(source, 0)
  h.emit('propulsion.main.revolutions', 1500 / 60)
  assert.equal(await engineRunning(h), true)
})
