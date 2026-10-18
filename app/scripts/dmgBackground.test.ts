import { readFileSync } from 'node:fs'
import path from 'node:path'

const appRoot = path.resolve(__dirname, '..')
const tauriDir = path.join(appRoot, 'src-tauri')
const { dmg } = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8')).bundle
  .macOS

function pngSize(file: string) {
  const header = readFileSync(path.resolve(tauriDir, file))
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

describe('DMG installer window', () => {
  const window = dmg.windowSize

  it('has a 1x background matching the window size', () => {
    expect(pngSize(dmg.background)).toEqual(window)
  })

  it('has a @2x background exactly double the 1x', () => {
    expect(pngSize(dmg.background.replace('.png', '@2x.png'))).toEqual({
      width: window.width * 2,
      height: window.height * 2,
    })
  })

  it('places every icon inside the window', () => {
    for (const { x, y } of [dmg.appPosition, dmg.applicationFolderPosition]) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(window.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(window.height)
    }
  })
})
