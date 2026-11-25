import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globPattern } from '../server/precheck.ts'

test('a proof pattern matches the committed files it names', () => {
  const maps = globPattern('data/maps/harbor_*.json')
  assert.ok(maps.test('data/maps/harbor_beach.json'))
  assert.ok(!maps.test('data/maps/market_beach.json'))
  assert.ok(!maps.test('data/maps/harbor_x/deep.json'))
  assert.ok(globPattern('docs/shots/**/*.png').test('docs/shots/tak708/a/1.png'))
  assert.ok(globPattern('docs/shot?.md').test('docs/shot1.md'))
})
