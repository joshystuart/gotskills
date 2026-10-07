import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import config from '../electron-builder.config.mjs'

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
const svg = readFileSync(path.join(buildDir, 'background.svg'))

const { width } = config.dmg.window

for (const [file, scale] of [
  ['background.png', 1],
  ['background@2x.png', 2],
]) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * scale },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
  })
    .render()
    .asPng()
  writeFileSync(path.join(buildDir, file), png)
}
