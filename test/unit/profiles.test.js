const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, useClock, sampleCsv, BASE_12 } = require('../helpers/harness')

async function started (t, options) {
  useClock(t)
  const h = createHarness()
  t.after(() => h.stop())
  h.start(options || {})
  return h
}

test('starts with a single active "default" profile', async (t) => {
  const h = await started(t)
  const { body } = await h.get('/profiles')
  assert.equal(body.active, 'default')
  assert.deepEqual(body.profiles.map((p) => p.id), ['default'])
})

test('creating a profile slugs the name, activates it, and rejects duplicates', async (t) => {
  const h = await started(t)
  const created = await h.post('/profiles', { name: 'Light Air Genoa' })
  assert.equal(created.body.id, 'light-air-genoa')
  assert.equal(created.body.active, 'light-air-genoa')
  assert.equal((await h.post('/profiles', { name: 'Light Air Genoa' })).status, 409)
  assert.equal((await h.post('/profiles', { name: '' })).status, 400)
})

test('profiles can be switched, and the last one cannot be deleted', async (t) => {
  const h = await started(t)
  await h.post('/profiles', { name: 'second' })
  assert.equal((await h.post('/profiles/default/activate')).body.active, 'default')
  assert.equal((await h.post('/profiles/nope/activate')).status, 404)

  assert.equal((await h.del('/profiles/second')).body.ok, true)
  assert.equal((await h.del('/profiles/default')).status, 400)
  assert.equal((await h.del('/profiles/nope')).status, 404)
})

test('deleting the active profile falls back to another one', async (t) => {
  const h = await started(t)
  await h.post('/profiles', { name: 'second' })
  const res = await h.del('/profiles/second')
  assert.equal(res.body.active, 'default')
})

test('CSV import fills the profile, and export round-trips it', async (t) => {
  const h = await started(t)
  const imported = await h.importCsv(sampleCsv())
  assert.equal(imported.body.ok, true)
  assert.equal(imported.body.imported, Object.keys(BASE_12).length * 3)

  const csv = (await h.get('/polar/csv')).body
  await h.post('/profiles', { name: 'copy' })
  await h.importCsv(csv, '?profile=copy')
  const original = (await h.get('/polar/matrix?profile=default')).body
  const copy = (await h.get('/polar/matrix?profile=copy')).body
  assert.deepEqual(copy, original)
})

test('tab-delimited .pol export imports back with the delimiter sniffed', async (t) => {
  const h = await started(t)
  await h.importCsv(sampleCsv())
  const pol = await h.get('/polar/export?format=pol')
  assert.match(pol.headers['content-disposition'], /default-polar\.pol/)
  assert.ok(pol.body.split('\n')[0].includes('\t'))

  await h.post('/profiles', { name: 'fromPol' })
  assert.equal((await h.importCsv(pol.body, '?profile=frompol')).body.ok, true)
})

test('import replace wipes the profile, merge only overwrites the imported buckets', async (t) => {
  const h = await started(t)
  await h.importCsv(sampleCsv())
  const full = (await h.get('/polar.json')).body.cellCount

  await h.importCsv('TWA\\TWS,12\n40,9.9', '?mode=merge')
  assert.equal((await h.get('/polar.json')).body.cellCount, full)
  const cell = (await h.get('/polar.json')).body.cells.find((c) => c.tws === 12 && c.twa === 40)
  assert.equal(cell.polarBsp, 9.9)

  await h.importCsv('TWA\\TWS,12\n40,9.9', '?mode=replace')
  assert.equal((await h.get('/polar.json')).body.cellCount, 1)
})

test('bad imports are rejected with a 400', async (t) => {
  const h = await started(t)
  assert.equal((await h.importCsv('not,a\nmatrix')).status, 400)
  assert.equal((await h.importCsv('', '')).status, 400)
})

test('reset clears only the chosen profile', async (t) => {
  const h = await started(t)
  await h.importCsv(sampleCsv())
  await h.post('/profiles', { name: 'other' })
  await h.importCsv(sampleCsv(), '?profile=other')
  await h.post('/polar/reset?profile=other')
  assert.equal((await h.get('/polar.json?profile=other')).body.cellCount, 0)
  assert.ok((await h.get('/polar.json?profile=default')).body.cellCount > 0)
})

test('unknown profile on the polar routes is a 404', async (t) => {
  const h = await started(t)
  assert.equal((await h.get('/polar.json?profile=nope')).status, 404)
  assert.equal((await h.get('/polar/csv?profile=nope')).status, 404)
})

test('sail config: live label is built from sails.inventory.*, sorted, with reefs', async (t) => {
  const h = await started(t)
  assert.equal((await h.get('/profiles')).body.currentSailConfig, null)
  h.emit('sails.inventory.main.active', true)
  h.emit('sails.inventory.main.name', 'Main')
  h.emit('sails.inventory.j1.active', true)
  h.emit('sails.inventory.j1.name', 'J1')
  assert.equal((await h.get('/profiles')).body.currentSailConfig, 'J1+Main')

  h.emit('sails.inventory.main.reducedState', { reduced: true, reefs: 1 })
  assert.equal((await h.get('/profiles')).body.currentSailConfig, 'J1+Main(reef1)')

  h.emit('sails.inventory.j1.active', false)
  assert.equal((await h.get('/profiles')).body.currentSailConfig, 'Main(reef1)')
})

test('sail config tags can be set, shown and cleared', async (t) => {
  const h = await started(t)
  assert.equal((await h.post('/profiles/default/sail-config', { sailConfig: ' Main ' })).body.sailConfig, 'Main')
  assert.equal((await h.get('/profiles')).body.profiles[0].sailConfig, 'Main')
  assert.equal((await h.post('/profiles/default/sail-config', {})).body.sailConfig, null)
  assert.equal((await h.post('/profiles/nope/sail-config', { sailConfig: 'x' })).status, 404)
})

test('autoSwitchBySailConfig switches to the profile tagged for the live sails', async (t) => {
  const h = await started(t, { autoSwitchBySailConfig: true })
  await h.post('/profiles', { name: 'main only' })
  await h.post('/profiles/main-only/sail-config', { sailConfig: 'Main' })
  await h.post('/profiles/default/activate')

  h.emit('sails.inventory.main.active', true)
  h.emit('sails.inventory.main.name', 'Main')
  assert.equal((await h.get('/profiles')).body.active, 'main-only')
})

test('without autoSwitchBySailConfig the active profile never changes on its own', async (t) => {
  const h = await started(t)
  await h.post('/profiles', { name: 'main only' })
  await h.post('/profiles/main-only/sail-config', { sailConfig: 'Main' })
  await h.post('/profiles/default/activate')

  h.emit('sails.inventory.main.active', true)
  h.emit('sails.inventory.main.name', 'Main')
  assert.equal((await h.get('/profiles')).body.active, 'default')
})

test('inputs panel marks wind and speed inactive until data arrives, then active', async (t) => {
  const h = await started(t)
  const before = (await h.get('/inputs')).body.inputs
  const required = before.filter((i) => i.required)
  assert.ok(required.length >= 3)
  assert.ok(required.every((i) => i.active === false))

  h.emit('navigation.speedThroughWater', 3)
  h.emit('environment.wind.speedTrue', 6)
  h.emit('environment.wind.angleTrueWater', 0.7)
  const after = (await h.get('/inputs')).body.inputs.filter((i) => i.required)
  assert.ok(after.every((i) => i.active === true))
})
