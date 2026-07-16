import { describe, it, expect } from 'vitest'
import { computeStickBounds, type DisplayInfo } from '../electron/main/geometry'

function makeDisplay(id: number, x: number, y: number, w: number, h: number): DisplayInfo {
  return { id, workArea: { x, y, width: w, height: h } }
}

const primary = makeDisplay(1, 0, 0, 1920, 1080)
const secondaryRight = makeDisplay(2, 1920, 0, 1920, 1080)
const secondaryNegX = makeDisplay(3, -1920, 0, 1920, 1080)
const secondaryNegY = makeDisplay(4, 0, -1080, 1920, 1080)

describe('computeStickBounds', () => {
  it('sticks to left edge of primary display', () => {
    const result = computeStickBounds({
      position: 'left',
      displays: [primary],
      windowWidth: 384,
      windowHeight: 1080
    })
    expect(result).toEqual({ x: 0, y: 0, width: 384, height: 1080, displayId: 1 })
  })

  it('sticks to right edge of secondary display to the right', () => {
    const result = computeStickBounds({
      position: 'right',
      displays: [primary, secondaryRight],
      displayId: 2,
      windowWidth: 384,
      windowHeight: 1080
    })
    expect(result).toEqual({ x: 3456, y: 0, width: 384, height: 1080, displayId: 2 })
  })

  it('sticks to right edge of display with negative x', () => {
    const result = computeStickBounds({
      position: 'right',
      displays: [primary, secondaryNegX],
      displayId: 3,
      windowWidth: 384,
      windowHeight: 1080
    })
    expect(result).toEqual({ x: -384, y: 0, width: 384, height: 1080, displayId: 3 })
  })

  it('sticks to top edge of display with negative y', () => {
    const result = computeStickBounds({
      position: 'top',
      displays: [primary, secondaryNegY],
      displayId: 4,
      windowWidth: 384,
      windowHeight: 600
    })
    expect(result).toEqual({ x: 768, y: -1080, width: 384, height: 600, displayId: 4 })
  })

  it('falls back to nearest display when saved display is missing', () => {
    const result = computeStickBounds({
      position: 'left',
      displays: [primary, secondaryRight],
      displayId: 99,
      currentBounds: { x: 2000, y: 100 },
      windowWidth: 384,
      windowHeight: 1080
    })
    expect(result.displayId).toBe(2)
  })

  it('falls back to primary when saved display missing and no current bounds', () => {
    const result = computeStickBounds({
      position: 'left',
      displays: [primary, secondaryRight],
      displayId: 99,
      windowWidth: 384,
      windowHeight: 1080
    })
    expect(result.displayId).toBe(1)
  })

  it('clamps window larger than work area', () => {
    const small = makeDisplay(5, 0, 0, 800, 600)
    const result = computeStickBounds({
      position: 'left',
      displays: [small],
      windowWidth: 1000,
      windowHeight: 800
    })
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
    expect(result.width).toBe(1000)
    expect(result.height).toBe(600)
  })
})
