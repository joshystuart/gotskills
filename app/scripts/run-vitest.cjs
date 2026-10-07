const { spawn } = require('node:child_process')
const path = require('node:path')

const electronPath = require('electron')
const vitestPath = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electronPath, [vitestPath, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Failed to launch Vitest with Electron: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exitCode = code ?? 1
})
