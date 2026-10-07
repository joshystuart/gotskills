import { readFileSync } from 'node:fs'
import path from 'node:path'
import { checkDriftProblems } from './checkDrift.mjs'

const repoRoot = path.resolve(__dirname, '..', '..')
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/pr-electron.yml'), 'utf8')
const checkScript: string = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  .scripts.check

describe('drift test', () => {
  it('runs every non-exempt step of the PR workflow', () => {
    expect(checkDriftProblems(workflow, checkScript)).toEqual([])
  })

  it('names a workflow step that check does not run', () => {
    const extended = workflow.replace(
      '      - name: Typecheck',
      '      - name: Lint\n        working-directory: app\n        run: npm run lint\n\n      - name: Typecheck'
    )

    expect(checkDriftProblems(extended, checkScript)).toEqual([
      '"Lint" (npm run lint) is not run by check',
    ])
  })

  it('fails when an exempt step disappears from the workflow', () => {
    const withoutSmoke = workflow.replace('run: scripts/smoke-packaged-cli.sh', 'run: echo skipped')

    expect(checkDriftProblems(withoutSmoke, `${checkScript} && echo skipped`)).toEqual([
      'exempt command "scripts/smoke-packaged-cli.sh" no longer appears in the workflow',
    ])
  })
})
