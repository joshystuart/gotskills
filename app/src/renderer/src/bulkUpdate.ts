import type {
  CatalogueSnapshot,
  InstallRequest,
  InstallResult,
  SyncAllResult,
} from '../../shared/ipc'
import { deriveUpdateWork, type UpdateItem } from './cataloguePresentation'

/**
 * The subset of the renderer api the bulk-update run depends on. Every item
 * goes through the exact single-Skill `repair` call the detail pane's Update
 * button already uses, so bulk and single-Skill update cannot diverge.
 */
export interface BulkUpdateApi {
  repair(req: InstallRequest): Promise<InstallResult>
  /** Refreshes every enabled Registry. Never rejects for a per-Registry failure. */
  refresh(): Promise<SyncAllResult>
  getCatalogue(): Promise<CatalogueSnapshot>
}

export interface BulkUpdateProgress {
  /** 0-based position of `item` within the run. */
  index: number
  total: number
  item: UpdateItem
}

export interface BulkUpdateFailure {
  item: UpdateItem
  /** Already-redacted error text from the install path. */
  reason: string
}

export interface BulkUpdateResult {
  updated: number
  failures: BulkUpdateFailure[]
  cancelled: boolean
  /**
   * The post-refresh work set the run actually dispatched against — may
   * differ in membership and count from whatever was shown on the button at
   * click time.
   */
  items: UpdateItem[]
  /**
   * Stale-gated items held back because the run-level acknowledgement was
   * off. Reported as held back in the summary, never as failures; each one
   * is still behind and is naturally part of the next run.
   */
  heldBack: UpdateItem[]
}

export interface RunBulkUpdateOptions {
  api: BulkUpdateApi
  /**
   * Reads the Registry revision current *at dispatch time* — a live accessor,
   * not a map snapshotted at run start. A background sync landing between two
   * items is absorbed: the later item pins and installs the new revision
   * instead of being refused as a stale selection.
   */
  getRevision: (registryId: string) => string | undefined
  onProgress?: (progress: BulkUpdateProgress) => void
  /**
   * Checked before each dispatch, wired to the run region's Cancel control.
   * A cancel during the refresh phase means no item is dispatched at all; a
   * cancel during an item lets that item run to completion — no Skill is
   * left half-installed — and stops the run before the next dispatch.
   */
  isCancelled?: () => boolean
  /**
   * The single run-level stale-Registry acknowledgement. Off (the default):
   * no stale-gated item is dispatched at all. On: stale-gated items — and
   * only those — carry `acknowledgeStale` on their repair request. One
   * acknowledgement covers every stale Registry contributing to the run;
   * there is deliberately no per-Registry or per-Skill opt-in.
   */
  acknowledgeStale?: boolean
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Drives a bulk update: refreshes every enabled Registry and awaits it, then
 * derives the work set from that post-refresh Catalogue — so "update all"
 * means updating to what is genuinely latest, not to whatever the last
 * background sync happened to leave behind. A Skill that became behind
 * during the refresh is picked up; one that stopped being behind is
 * excluded. Items are then dispatched sequentially: the next item is never
 * dispatched until the previous one settles, and a failing item (including
 * one whose Skill vanished from its Registry during the refresh) is recorded
 * without aborting the remainder. Cancellation stops the loop before the
 * next dispatch; the item in flight always runs to completion, and the
 * result reports the cancellation alongside what did land. Items supplied by
 * a stale Registry Snapshot are held back unless the run-level
 * acknowledgement is on, in which case they — and only they — carry the
 * stale acknowledgement flag.
 */
export async function runBulkUpdate(options: RunBulkUpdateOptions): Promise<BulkUpdateResult> {
  const { api, getRevision, onProgress, isCancelled, acknowledgeStale } = options

  await api.refresh()
  const snapshot = await api.getCatalogue()
  const work = deriveUpdateWork(snapshot.skills, snapshot.syncStatus)
  /**
   * Held-back items are never dispatched: updating from a stale Registry
   * Snapshot by default would mean acting on content of unknown age.
   */
  const heldBack = acknowledgeStale === true ? [] : work.staleGated
  const items = work.all.filter((item) => acknowledgeStale === true || !item.staleGated)

  let updated = 0
  const failures: BulkUpdateFailure[] = []

  for (let index = 0; index < items.length; index++) {
    if (isCancelled?.()) {
      return { updated, failures, cancelled: true, items, heldBack }
    }

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

    try {
      await api.repair(request)
      updated++
    } catch (err) {
      failures.push({ item, reason: errorReason(err) })
    }
  }

  return { updated, failures, cancelled: false, items, heldBack }
}
