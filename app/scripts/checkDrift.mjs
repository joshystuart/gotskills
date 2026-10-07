import { parse } from 'yaml'

const exemptCommands = [
  'npm ci',
  'npm run package:dir',
  'scripts/check-app-size.sh',
  'scripts/smoke-packaged-cli.sh',
]

function runCommands(workflowText) {
  const { jobs } = parse(workflowText)
  return Object.values(jobs).flatMap((job) =>
    job.steps.filter((step) => step.run).map((step) => ({ name: step.name, run: step.run.trim() }))
  )
}

export function checkDriftProblems(workflowText, checkScript) {
  const steps = runCommands(workflowText)
  const missing = steps
    .filter((step) => !exemptCommands.includes(step.run) && !checkScript.includes(step.run))
    .map((step) => `"${step.name}" (${step.run}) is not run by check`)
  const stale = exemptCommands
    .filter((command) => !steps.some((step) => step.run === command))
    .map((command) => `exempt command "${command}" no longer appears in the workflow`)
  return [...missing, ...stale]
}
