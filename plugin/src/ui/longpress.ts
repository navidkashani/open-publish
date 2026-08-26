/**
 * Press and hold, with the timing separated from the device.
 *
 * The remove control on a rule row is hover-revealed, and there is no hover on
 * a phone, so touch needs a second way in. A gesture is the kind of thing that
 * is normally only testable by picking up a device, which is exactly why the
 * decision-making lives here: given a clock and a stream of pointer events, does
 * it fire? Everything device-shaped stays in the caller.
 *
 * The two rules that matter are both about *not* firing: a finger that travels
 * is a scroll, and a finger that lifts early is a tap.
 */

export interface PressPoint {
  x: number
  y: number
}

/** Injectable so tests can drive it with a fake clock. */
export interface LongPressTimers {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
}

export interface LongPressOptions {
  onLongPress: (point: PressPoint) => void
  /** Obsidian's own touch menus sit around half a second. */
  delayMs?: number
  /** Past this much travel the press is a scroll, not a hold. */
  moveTolerancePx?: number
  timers?: LongPressTimers
}

export const LONG_PRESS_MS = 500
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

/**
 * Watch `el` for a press-and-hold. Returns a function that detaches everything,
 * so a re-rendered list cannot leave listeners behind on discarded rows.
 */
export function attachLongPress(el: HTMLElement, options: LongPressOptions): () => void {
  const delay = options.delayMs ?? LONG_PRESS_MS
  const tolerance = options.moveTolerancePx ?? LONG_PRESS_MOVE_TOLERANCE_PX
  const timers = options.timers ?? window

  let timer: number | null = null
  let origin: PressPoint | null = null

  const cancel = (): void => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    origin = null
  }

  const pointOf = (event: PointerEvent): PressPoint => ({ x: event.clientX ?? 0, y: event.clientY ?? 0 })

  const onDown = (event: PointerEvent): void => {
    // Mouse and pen already have hover, which reveals the control directly.
    if (event.pointerType && event.pointerType !== 'touch') return
    cancel()
    const point = pointOf(event)
    origin = point
    timer = timers.setTimeout(() => {
      timer = null
      origin = null
      options.onLongPress(point)
    }, delay)
  }

  const onMove = (event: PointerEvent): void => {
    if (!origin) return
    const point = pointOf(event)
    if (Math.abs(point.x - origin.x) > tolerance || Math.abs(point.y - origin.y) > tolerance) cancel()
  }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', cancel)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('pointerleave', cancel)

  return () => {
    cancel()
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', cancel)
    el.removeEventListener('pointercancel', cancel)
    el.removeEventListener('pointerleave', cancel)
  }
}
