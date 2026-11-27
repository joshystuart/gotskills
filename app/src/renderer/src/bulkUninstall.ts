import type {
  InstallTargetId,
  SkillSummary,
  UninstallRequest,
  UninstallResult,
} from '../../shared/ipc'
import { INSTALLED_LIKE, targetsInStates } from './cataloguePresentation'

/** One selected Skill's uninstall work: the chosen targets it is installed in. */
export interface UninstallItem {
  registryId: string
  folderName: string
  /** Composite `${registryId}/${folderName}`, matching `SkillSummary.id`. */
  skillId: string
  name: string
  targets: InstallTargetId[]
}

/**
 * Decides, for each selected Skill, which of the chosen targets it is
 * uninstalled from. Only targets where Got Skills installed it count, so a
 * collided target, which holds someone else's skill, is never removed.
 */
export function deriveUninstallWork(
  skills: SkillSummary[],
  chosenTargets: InstallTargetId[]
): UninstallItem[] {
  return skills.flatMap((skill) => {
    const targets = targetsInStates(skill, chosenTargets, INSTALLED_LIKE)
    if (targets.length === 0) return []
    return [
      {
        registryId: skill.registryId,
        folderName: skill.folderName,
        skillId: skill.id,
        name: skill.name,
        targets,
      },
    ]
  })
}

export interface BulkUninstallApi {
  uninstall(req: UninstallRequest): Promise<UninstallResult>
}

export interface BulkUninstallProgress {
  /** 0-based position of `item` within the run. */
  index: number
  total: number
  item: UninstallItem
}

export interface BulkUninstallFailure {
  item: UninstallItem
  /** Already-redacted error text from the uninstall path. */
  reason: string
}

export interface BulkUninstallResult {
  uninstalled: number
  failures: BulkUninstallFailure[]
  cancelled: boolean
}

export interface RunBulkUninstallOptions {
  api: BulkUninstallApi
  items: UninstallItem[]
  onProgress?: (progress: BulkUninstallProgress) => void
  /** Checked before each dispatch; the Skill in flight always finishes. */
  isCancelled?: () => boolean
}

function failureReason(result: UninstallResult): string | null {
  const errors = result.perTarget
    .filter((target) => target.outcome === 'failed')
    .map((target) => target.error ?? `Could not remove from ${target.target}.`)
  return errors.length > 0 ? errors.join('; ') : null
}

/**
 * Uninstalls the Skills one at a time through the same `uninstall` call the
 * detail panel uses. A Skill fails when the call throws or any of its targets
 * reports a failure; the run continues, and a cancel stops it before the
 * next dispatch.
 */
export async function runBulkUninstall(
  options: RunBulkUninstallOptions
): Promise<BulkUninstallResult> {
  const { api, items, onProgress, isCancelled } = options
  let uninstalled = 0
  const failures: BulkUninstallFailure[] = []

  for (let index = 0; index < items.length; index++) {
    if (isCancelled?.()) return { uninstalled, failures, cancelled: true }

    const item = items[index]
    onProgress?.({ index, total: items.length, item })

    try {
      const result = await api.uninstall({
        registryId: item.registryId,
        folderName: item.folderName,
        targets: item.targets,
      })
      const reason = failureReason(result)
      if (reason) failures.push({ item, reason })
      else uninstalled++
    } catch (err) {
      failures.push({ item, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { uninstalled, failures, cancelled: false }
}
