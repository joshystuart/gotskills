import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'

type Step = {
  name: string
  run?: string
  if?: string
  uses?: string
  with?: Record<string, unknown>
}
type Job = {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  strategy?: { matrix: { target: string[] } }
  steps: Step[]
}

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/tauri-release.yml', import.meta.url), 'utf8')
) as { jobs: Record<string, Job> }
const resolve = workflow.jobs['resolve-release']
const build = workflow.jobs['build-binaries']
const release = workflow.jobs['build-and-release']
const command = (job: Job, name: string) => job.steps.find((step) => step.name === name)!.run!
const fixtures: string[] = []

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-workflow-'))
  fixtures.push(root)
  mkdirSync(path.join(root, 'app', 'src-tauri'), { recursive: true })
  writeFileSync(path.join(root, 'app', 'package.json'), '{"name":"release-test","version":"1.2.3"}')
  writeFileSync(
    path.join(root, 'app', 'src-tauri', 'Cargo.toml'),
    '[package]\nname = "release-test"\nversion = "0.0.1"\n[dependencies]\nserde = "1"\n'
  )
  return root
}

function run(script: string, cwd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

afterEach(() => {
  fixtures.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('release orchestration', () => {
  it('builds both architectures independently before publishing their pinned revision', () => {
    expect(build.needs).toBe('resolve-release')
    expect(build.if).toBe("needs.resolve-release.outputs.skip != 'true'")
    expect(build.strategy?.matrix.target).toEqual(['aarch64-apple-darwin', 'x86_64-apple-darwin'])
    expect(build.permissions?.contents).toBe('read')
    expect(release.needs).toEqual(['resolve-release', 'build-binaries'])
    expect(release.if).toBeUndefined()
    for (const job of [build, release]) {
      expect(job.steps[0].with?.ref).toBe('${{ needs.resolve-release.outputs.revision }}')
    }
    expect(command(build, 'Build release binary')).toBe(
      'npm run build -- --target ${{ matrix.target }} --no-bundle --config \'{"bundle":{"createUpdaterArtifacts":true}}\''
    )
    expect(build.steps.find((step) => step.name === 'Cache cargo')?.with?.key).toBe(
      '${{ matrix.target }}'
    )
    expect(
      build.steps.find((step) => step.name === 'Upload release binary')?.with?.['if-no-files-found']
    ).toBe('error')
  })

  it('keeps signing, notarization, updater feeds, and publishing behind the dry-run guard', () => {
    for (const name of [
      'Import Apple signing certificate',
      'Bundle signed release files',
      'Verify release signing and notarization',
      'Collect release files and write latest.json',
      'Create or update GitHub Release',
    ]) {
      expect(release.steps.find((step) => step.name === name)?.if).toBe('inputs.dry_run != true')
    }
    expect(command(release, 'Bundle signed release files')).toContain('--bundles app,dmg,updater')
    expect(command(release, 'Bundle signed release files')).toContain(
      '"createUpdaterArtifacts":true'
    )
    expect(command(release, 'Bundle signed release files')).not.toMatch(/--no-sign|--skip-stapling/)
    expect(command(release, 'Verify release signing and notarization')).toContain(
      'codesign --verify --deep --strict'
    )
    expect(command(release, 'Verify release signing and notarization')).toContain(
      'xcrun stapler validate'
    )
    expect(command(release, 'Bundle unsigned dry run')).toContain('--no-sign')
    expect(command(release, 'Check universal app and size')).toContain('scripts/check-app-size.sh')
  })

  it('applies the same release version to both compile jobs and the bundler', () => {
    const root = fixture()
    const script = command(build, 'Set release version')
    expect(command(release, 'Set release version')).toBe(script)
    const result = run(script, path.join(root, 'app'), { RELEASE_VERSION: '1.2.4-rc.1' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(root, 'app', 'package.json'), 'utf8')).version).toBe(
      '1.2.4-rc.1'
    )
    expect(readFileSync(path.join(root, 'app', 'src-tauri', 'Cargo.toml'), 'utf8')).toContain(
      'version = "1.2.4-rc.1"\n[dependencies]\nserde = "1"'
    )
  })
})

describe('release resolution', () => {
  function resolveFixture(event: string, ref: string, tag = '', exists = false) {
    const root = fixture()
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    for (const [name, script] of Object.entries({
      git: '#!/bin/sh\ntest "$*" = "rev-parse HEAD" || exit 1\necho abc123\n',
      gh: '#!/bin/sh\nexit "$RELEASE_EXISTS"\n',
    })) {
      writeFileSync(path.join(bin, name), script, { mode: 0o755 })
    }
    const output = path.join(root, 'output')
    writeFileSync(output, '')
    const result = run(command(resolve, 'Resolve release tag'), root, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_REF_NAME: ref.replace('refs/tags/', ''),
      REQUESTED_TAG: tag,
      RELEASE_EXISTS: exists ? '0' : '1',
    })
    return { ...result, output: readFileSync(output, 'utf8') }
  }

  it('skips an already published main version before scheduling macOS work', () => {
    const result = resolveFixture('push', 'refs/heads/main', '', true)
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe('skip=true\n')
  })

  it.each([
    ['push', 'refs/heads/main', '', '1.2.3'],
    ['push', 'refs/tags/v1.2.4', '', '1.2.4'],
    ['workflow_dispatch', 'refs/heads/perf/ci-runtime', 'v1.2.5-rc.1', '1.2.5-rc.1'],
  ])('resolves %s / %s / %s to one immutable revision', (event, ref, tag, version) => {
    const result = resolveFixture(event, ref, tag)
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe(`tag=v${version}\nversion=${version}\nrevision=abc123\n`)
  })

  it.each(['vwrong', 'v1.2.3$(touch injected)', 'v1.2.3"', 'v1.2.3\nrevision=bad'])(
    'rejects an invalid release tag %s',
    (tag) => {
      const result = resolveFixture('workflow_dispatch', 'refs/heads/main', tag)
      expect(result.status).not.toBe(0)
      expect(result.output).toBe('')
    }
  )
})

describe.skipIf(process.platform !== 'darwin')('universal assembly', () => {
  it('combines both Mach-O architectures and restores the downloaded executable permission', () => {
    const root = fixture()
    const source = path.join(root, 'main.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    for (const [target, arch] of [
      ['aarch64', 'arm64'],
      ['x86_64', 'x86_64'],
    ]) {
      const dir = path.join(root, 'release-binaries', `release-bin-${target}-apple-darwin`)
      mkdirSync(dir, { recursive: true })
      const output = path.join(dir, 'got-skills')
      execFileSync('clang', ['-target', `${arch}-apple-macos11`, '-c', source, '-o', output])
      chmodSync(output, 0o644)
    }
    const result = run(command(release, 'Assemble universal binary'), root)
    expect(result.status, result.stderr).toBe(0)
    const binary = path.join(root, 'app/src-tauri/target/universal-apple-darwin/release/got-skills')
    expect(
      execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(' ').sort()
    ).toEqual(['arm64', 'x86_64'])
    expect(statSync(binary).mode & 0o111).toBe(0o111)
  })

  it('rejects a missing architecture before a bundle can be published', () => {
    const result = run(command(release, 'Assemble universal binary'), fixture())
    expect(result.status).not.toBe(0)
  })
})
