import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const guard = path.join(__dirname, 'checkUpdateFeed.mjs')
const folders: string[] = []

function buildOutput(feed: string, files: string[]) {
  const folder = mkdtempSync(path.join(tmpdir(), 'update-feed-'))
  folders.push(folder)
  writeFileSync(path.join(folder, 'latest-mac.yml'), feed)
  for (const file of files) writeFileSync(path.join(folder, file), '')
  return folder
}

function runGuard(folder: string) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [guard, folder], {
    encoding: 'utf8',
  })
  return { status, output: stdout + stderr }
}

const matchingFeed = `version: 0.0.8
files:
  - url: Got-Skills-0.0.8-arm64.zip
    sha512: abc
    size: 1
  - url: Got-Skills-0.0.8-x64.zip
    sha512: def
    size: 1
path: Got-Skills-0.0.8-arm64.zip
sha512: abc
releaseDate: '2026-10-08T00:00:00.000Z'
`

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('update feed guard', () => {
  it('passes when every file the feed names is in the build output', () => {
    const folder = buildOutput(matchingFeed, [
      'Got-Skills-0.0.8-arm64.zip',
      'Got-Skills-0.0.8-x64.zip',
    ])

    expect(runGuard(folder).status).toBe(0)
  })

  it('fails and names a file the feed lists but the build did not produce', () => {
    const folder = buildOutput(matchingFeed, ['Got-Skills-0.0.8-arm64.zip'])

    const result = runGuard(folder)

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Got-Skills-0.0.8-x64.zip')
  })

  it('fails and names a file whose name holds a space', () => {
    const feed = matchingFeed.replace(
      'url: Got-Skills-0.0.8-x64.zip',
      'url: Got Skills-0.0.8-x64.zip'
    )
    const folder = buildOutput(feed, ['Got-Skills-0.0.8-arm64.zip', 'Got Skills-0.0.8-x64.zip'])

    const result = runGuard(folder)

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Got Skills-0.0.8-x64.zip')
  })

  it('checks the top-level path as well as each url', () => {
    const feed = matchingFeed.replace(
      'path: Got-Skills-0.0.8-arm64.zip',
      'path: Got Skills-0.0.8-arm64.zip'
    )
    const folder = buildOutput(feed, ['Got-Skills-0.0.8-arm64.zip', 'Got-Skills-0.0.8-x64.zip'])

    const result = runGuard(folder)

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Got Skills-0.0.8-arm64.zip')
  })
})
