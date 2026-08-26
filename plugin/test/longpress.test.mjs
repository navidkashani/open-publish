/**
 * The gesture, without a device.
 *
 * A press-and-hold is normally only testable by picking up a phone, which is
 * why the decision-making was pulled out of the DOM: given a clock and a stream
 * of pointer events, does it fire? Most of these assert that it does *not*:
 * a scroll and a tap both start exactly like a hold, and firing on either would
 * mean a rule vanishing under someone's thumb.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, el } from './dom.mjs'
import { attachLongPress } from '../src/ui/longpress.ts'

/** A clock that only moves when the test says so. */
function fakeClock() {
  const pending = new Map()
  let nextId = 1
  return {
    timers: {
      setTimeout(handler, ms) {
        const id = nextId++
        pending.set(id, { handler, at: ms })
        return id
      },
      clearTimeout(id) {
        pending.delete(id)
      },
    },
    get scheduled() {
      return pending.size
    },
    advance(ms) {
      for (const [id, timer] of [...pending]) {
        if (timer.at <= ms) {
          pending.delete(id)
          timer.handler()
        }
      }
    },
  }
}

function stage(options = {}) {
  const clock = fakeClock()
  const row = el()
  const fired = []
  const detach = attachLongPress(row, {
    onLongPress: (point) => fired.push(point),
    timers: clock.timers,
    ...options,
  })
  return { clock, row, fired, detach }
}

const touch = (props = {}) => ({ pointerType: 'touch', clientX: 0, clientY: 0, ...props })

test('holding still for the full delay fires once, at the point it started', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', touch({ clientX: 40, clientY: 120 }))
  clock.advance(500)
  assert.deepEqual(fired, [{ x: 40, y: 120 }])

  clock.advance(500)
  assert.equal(fired.length, 1, 'and only once')
})

test('lifting early is a tap, not a hold', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', touch())
  dispatch(row, 'pointerup', touch())
  clock.advance(1000)
  assert.deepEqual(fired, [])
})

test('a finger that travels is a scroll, and must not remove anything', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', touch({ clientY: 100 }))
  dispatch(row, 'pointermove', touch({ clientY: 140 }))
  clock.advance(1000)
  assert.deepEqual(fired, [], 'the list scrolled under the thumb')
})

test('a small wobble is still a hold: fingers are not styluses', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', touch({ clientX: 10, clientY: 100 }))
  dispatch(row, 'pointermove', touch({ clientX: 13, clientY: 104 }))
  clock.advance(500)
  assert.equal(fired.length, 1)
})

test('a cancelled or departed pointer stops the timer', () => {
  for (const type of ['pointercancel', 'pointerleave']) {
    const { clock, row, fired } = stage()
    dispatch(row, 'pointerdown', touch())
    dispatch(row, type, touch())
    assert.equal(clock.scheduled, 0, `${type} cleared the timer rather than leaving it to fire`)
    clock.advance(1000)
    assert.deepEqual(fired, [])
  }
})

test('a mouse never long-presses: hover already reveals the control', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', { pointerType: 'mouse', clientX: 0, clientY: 0 })
  clock.advance(1000)
  assert.deepEqual(fired, [])
})

test('a second press supersedes the first rather than queueing behind it', () => {
  const { clock, row, fired } = stage()
  dispatch(row, 'pointerdown', touch({ clientX: 5 }))
  dispatch(row, 'pointerdown', touch({ clientX: 90 }))
  assert.equal(clock.scheduled, 1)
  clock.advance(500)
  assert.deepEqual(fired, [{ x: 90, y: 0 }])
})

test('detaching leaves no listeners and no pending timer behind', () => {
  const { clock, row, fired, detach } = stage()
  dispatch(row, 'pointerdown', touch())
  detach()

  assert.equal(clock.scheduled, 0)
  for (const handlers of row.listeners.values()) assert.equal(handlers.length, 0)

  dispatch(row, 'pointerdown', touch())
  clock.advance(1000)
  assert.deepEqual(fired, [], 'a re-rendered list cannot be haunted by its old rows')
})
