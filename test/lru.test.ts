import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit, subscribe, versionOf } from '../server/core.ts'
import { Lru } from '../server/lru.ts'

describe('Lru', () => {
  test('drops the least recently used entry first', () => {
    const lru = new Lru<number>({ maxEntries: 2 })
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a')
    lru.set('c', 3)
    assert.equal(lru.get('b'), undefined)
    assert.equal(lru.get('a'), 1)
    assert.equal(lru.get('c'), 3)
  })

  test('keeps within its byte budget and skips values larger than all of it', () => {
    const lru = new Lru<string>({ maxEntries: 100, maxSize: 10, sizeOf: (v) => v.length })
    lru.set('a', '12345')
    lru.set('b', '12345')
    lru.set('c', '123')
    assert.equal(lru.get('a'), undefined)
    assert.equal(lru.bytes, 8)
    lru.set('huge', 'x'.repeat(11))
    assert.equal(lru.get('huge'), undefined)
    assert.equal(lru.bytes, 8)
  })

  test('remember makes a value once and does not keep failures', async () => {
    const lru = new Lru<number>({ maxEntries: 10 })
    let calls = 0
    const make = async () => ++calls
    assert.equal(await lru.remember('k', make), 1)
    assert.equal(await lru.remember('k', make), 1)
    await assert.rejects(lru.remember('bad', async () => Promise.reject(new Error('no'))))
    assert.equal(lru.get('bad'), undefined)
  })
})

describe('event bus', () => {
  test('serializes an event once for all listeners and counts the version', () => {
    const before = versionOf(4242)
    const seen: string[] = []
    const off1 = subscribe(4242, (_e, json) => seen.push(json))
    const off2 = subscribe(4242, (_e, json) => seen.push(json))
    emit(4242, { t: 'notice', text: 'hi' })
    off1()
    off2()
    assert.equal(seen.length, 2)
    assert.equal(seen[0], '{"t":"notice","text":"hi"}')
    assert.ok(Object.is(seen[0], seen[1]))
    assert.equal(versionOf(4242), before + 1)
  })
})
