const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const script = join(__dirname, 'check-app-size.sh')
const defaultLimit = readFileSync(script, 'utf8').match(/limit_bytes="\$\{2:-(\d+)\}"/)[1]

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'app-size-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const app = join(directory, 'Got Skills.app')
  mkdirSync(app)
  return app
}

function check(...args) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8' })
}

test('an app below the budget passes and reports its size and limit', (t) => {
  const app = fixture(t)
  writeFileSync(join(app, 'payload'), 'small app')
  const result = check(app)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`App size: \\d+ bytes; limit: ${defaultLimit} bytes`))
})

test('an app above the budget fails and names both sizes', (t) => {
  const app = fixture(t)
  writeFileSync(join(app, 'payload'), Buffer.alloc(65536, 1))
  const result = check(app, '4096')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /App size: \d+ bytes; limit: 4096 bytes/)
  assert.match(result.stderr, /App size \d+ bytes exceeds limit 4096 bytes/)
})
