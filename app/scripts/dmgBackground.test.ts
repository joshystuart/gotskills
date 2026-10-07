import { readFileSync } from 'node:fs'
import path from 'node:path'
import config from '../electron-builder.config.mjs'

const buildDir = path.resolve(__dirname, '..', 'build')

function pngSize(file: string) {
  const header = readFileSync(path.join(buildDir, file))
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

describe('DMG installer window', () => {
  const { window, contents } = config.dmg

  it('has a 1x background matching the window size', () => {
    expect(pngSize('background.png')).toEqual({ width: window.width, height: window.height })
  })

  it('has a @2x background exactly double the 1x', () => {
    expect(pngSize('background@2x.png')).toEqual({
      width: window.width * 2,
      height: window.height * 2,
    })
  })

  it('places every icon inside the window', () => {
    for (const { x, y } of contents) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(window.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(window.height)
    }
  })
})
