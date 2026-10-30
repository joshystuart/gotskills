import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

type Job = {
  'runs-on': string
  if?: string
  needs?: string[]
  steps: { run?: string; env?: Record<string, string> }[]
}

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/pr-tauri.yml', import.meta.url), 'utf8')
) as { jobs: Record<string, Job> }
const gate = workflow.jobs['tauri-build']
const gateStep = gate.steps[0]
const statuses = ['success', 'failure', 'cancelled', 'skipped']
const combinations = statuses.flatMap((format) =>
  statuses.flatMap((tests) => statuses.map((build) => ({ format, tests, build })))
)

describe('PR build gate', () => {
  it('waits for every independent check, including after failure or skipping', () => {
    expect(gate.if).toBe('always()')
    expect([...(gate.needs ?? [])].sort()).toEqual(['app-tests', 'prettier-check', 'tauri-bundle'])
    expect(gateStep.env).toEqual({
      PRETTIER_RESULT: '${{ needs.prettier-check.result }}',
      TEST_RESULT: '${{ needs.app-tests.result }}',
      BUILD_RESULT: '${{ needs.tauri-bundle.result }}',
    })
    for (const job of gate.needs ?? []) {
      expect(workflow.jobs[job].needs).toBeUndefined()
    }
  })

  it.each(combinations)('handles $format / $tests / $build', ({ format, tests, build }) => {
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', gateStep.run!],
      {
        env: {
          ...process.env,
          PRETTIER_RESULT: format,
          TEST_RESULT: tests,
          BUILD_RESULT: build,
        },
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status === 0).toBe([format, tests, build].every((status) => status === 'success'))
  })

  it('keeps the full test suite and production bundle checks on macOS', () => {
    const tests = workflow.jobs['app-tests']
    const bundle = workflow.jobs['tauri-bundle']
    expect(tests['runs-on']).toBe('macos-latest')
    expect(bundle['runs-on']).toBe('macos-latest')
    expect(tests.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm test',
      'npm run test:rust',
      'node --test scripts/check-app-size.test.cjs',
    ])
    expect(bundle.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'npm ci',
      'npm run build',
      'scripts/check-app-size.sh',
    ])
    expect(
      workflow.jobs['prettier-check'].steps.some((step) => step.run === 'npm run format:check')
    ).toBe(true)
  })
})
