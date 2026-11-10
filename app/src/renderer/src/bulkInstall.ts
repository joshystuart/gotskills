import type {
  InstallRequest,
  InstallResult,
  InstallTargetId,
  SkillSummary,
  SyncStatus,
} from '../../shared/ipc'
import {
  isCollided,
  staleDisclosures,
  targetState,
  type StaleRegistryDisclosure,
} from './cataloguePresentation'

/** One selected Skill's install work: only the chosen targets it is missing from. */
export interface InstallItem {
  registryId: string
  folderName: string
  /** Composite `${registryId}/${folderName}`, matching `SkillSummary.id`. */
  skillId: string
  name: string
  targets: InstallTargetId[]
  /** The collided targets among `targets` that the install replaces. */
  replaceTargets: InstallTargetId[]
  /** True when the Skill comes from a stale Registry Snapshot. */
  staleGated: boolean
}

/** What installing a selection will do. */
export interface InstallWork {
  /** The Skills that will install, in selection order; n on the Install button. */
  items: InstallItem[]
  /** Selected Skills with nothing to install: fully installed or collided, installed-only or removed. */
  skipped: number
  /** Chosen targets left out because they hold an Installation Collision and replace is off. */
  skippedCollisions: number
  /** Stale Skills held back because the stale acknowledgement is off. */
  heldBack: InstallItem[]
  /** One per stale Registry among the installable Skills, acknowledged or not. */
  disclosures: StaleRegistryDisclosure[]
}

export interface InstallWorkOptions {
  acknowledgeStale: boolean
  /** Install over Installation Collisions instead of skipping those targets. */
  replace?: boolean
  /** True for an entry whose Registry is disabled or removed. */
  isInstalledOnly: (skill: SkillSummary) => boolean
  status?: SyncStatus | null
}

/**
 * Decides, for each selected Skill, whether it installs and into which of the
 * chosen targets. It never updates or repairs: a target that holds the Skill
 * is left alone, and a collided target is replaced only when `replace` is on.
 */
export function deriveInstallWork(
  skills: SkillSummary[],
  chosenTargets: InstallTargetId[],
  options: InstallWorkOptions
): InstallWork {
  const installable: InstallItem[] = []
  let skipped = 0
  let skippedCollisions = 0
  for (const skill of skills) {
    if (skill.softDeleted || options.isInstalledOnly(skill)) {
      skipped++
      continue
    }
    const collided = chosenTargets.filter((t) => isCollided(targetState(skill, t)))
    const replaceTargets = options.replace ? collided : []
    if (!options.replace) skippedCollisions += collided.length
    const targets = chosenTargets.filter(
      (t) => targetState(skill, t) === 'not-installed' || replaceTargets.includes(t)
    )
    if (targets.length === 0) {
      skipped++
      continue
    }
    installable.push({
      registryId: skill.registryId,
      folderName: skill.folderName,
      skillId: skill.id,
      name: skill.name,
      targets,
      replaceTargets,
      staleGated: skill.stale,
    })
  }
  const stale = installable.filter((item) => item.staleGated)
  return {
    items: options.acknowledgeStale ? installable : installable.filter((i) => !i.staleGated),
    skipped,
    skippedCollisions,
    heldBack: options.acknowledgeStale ? [] : stale,
    disclosures: staleDisclosures(stale, skills, options.status ?? null),
  }
}

export interface BulkInstallApi {
  install(req: InstallRequest): Promise<InstallResult>
}

export interface BulkInstallProgress {
  /** 0-based position of `item` within the run. */
  index: number
  total: number
  item: InstallItem
}

export interface BulkInstallFailure {
  item: InstallItem
  /** Already-redacted error text from the install path. */
  reason: string
}

export interface BulkInstallResult {
  installed: number
  failures: BulkInstallFailure[]
  heldBack: InstallItem[]
  cancelled: boolean
}

export interface RunBulkInstallOptions {
  api: BulkInstallApi
  work: InstallWork
  /** Reads a Registry's current revision at dispatch time. */
  getRevision: (registryId: string) => string | undefined
  onProgress?: (progress: BulkInstallProgress) => void
  /** Checked before each dispatch; the Skill in flight always finishes. */
  isCancelled?: () => boolean
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Installs the work's Skills one at a time through the same `install` call
 * the detail panel uses. A failure is recorded and the run continues; a
 * cancel stops it before the next dispatch. It never refreshes or repairs.
 */
export async function runBulkInstall(options: RunBulkInstallOptions): Promise<BulkInstallResult> {
  const { api, work, getRevision, onProgress, isCancelled } = options
  const { items, heldBack } = work
  let installed = 0
  const failures: BulkInstallFailure[] = []

  for (let index = 0; index < items.length; index++) {
    if (isCancelled?.()) return { installed, failures, heldBack, cancelled: true }

    const item = items[index]
    onProgress?.({ index, total: items.length, item })

    const revision = getRevision(item.registryId)
    if (!revision) {
      failures.push({ item, reason: 'No synced revision available for this registry.' })
      continue
    }

    const request: InstallRequest = {
      registryId: item.registryId,
      folderName: item.folderName,
      targets: item.targets,
      mirrorRevision: revision,
    }
    if (item.staleGated) request.acknowledgeStale = true
    if (item.replaceTargets.length > 0) request.replaceTargets = item.replaceTargets

    try {
      await api.install(request)
      installed++
    } catch (err) {
      failures.push({ item, reason: errorReason(err) })
    }
  }

  return { installed, failures, heldBack, cancelled: false }
}
