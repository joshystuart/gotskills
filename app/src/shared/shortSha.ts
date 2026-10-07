type MissingSha = null | undefined

export function shortSha(sha: string | MissingSha): string | undefined
export function shortSha<TMissing extends MissingSha>(
  sha: string | MissingSha,
  missingValue: TMissing
): string | TMissing
export function shortSha<TMissing extends MissingSha>(
  sha: string | MissingSha,
  missingValue?: TMissing
): string | TMissing | undefined {
  if (!sha) return missingValue
  return sha.length > 7 ? sha.slice(0, 7) : sha
}
