const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../helpers/harness')

test('plugin exposes the id, name and a schema with a default for every option', (t) => {
  const h = createHarness()
  t.after(() => h.stop())
  assert.equal(h.plugin.id, 'polar-builder')
  assert.ok(h.plugin.name)
  const props = h.plugin.schema.properties
  assert.ok(Object.keys(props).length >= 20)
  Object.keys(props).forEach((key) => {
    assert.ok('default' in props[key], `${key} has a default`)
    assert.ok(props[key].title, `${key} has a title`)
  })
})

test('start() applies the schema defaults when given no configuration', (t) => {
  const h = createHarness()
  t.after(() => h.stop())
  h.start({})
  const props = h.plugin.schema.properties
  // The subscription uses speedSource/windAngleSource from the effective options
  const paths = h.app.subscription.subscribe.map((s) => s.path)
  assert.ok(paths.includes(props.speedSource.default))
  assert.ok(paths.includes(props.windAngleSource.default))
  assert.ok(paths.includes('environment.wind.speedTrue'))
  assert.ok(paths.includes('propulsion.*.revolutions'))
})

test('optional features are off by default', (t) => {
  const h = createHarness()
  t.after(() => h.stop())
  const props = h.plugin.schema.properties
  assert.equal(props.enableMfdDisplay.default, false)
  assert.equal(props.autoSwitchBySailConfig.default, false)
  assert.equal(props.engineVoltageSource.default, '')
  assert.equal(props.publishPerformanceData.default, true)
})
