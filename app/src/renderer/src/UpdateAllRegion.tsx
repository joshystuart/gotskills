import type { JSX } from 'react'
import type { BulkUpdateFailure } from './bulkUpdate'
import type { StaleRegistryDisclosure, UpdateItem } from './cataloguePresentation'
import { HeldBackList, StaleDisclosures } from './StaleDisclosures'

export type UpdateAllPhase =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'updating'; index: number; total: number; item: UpdateItem }
  | { kind: 'failed'; reason: string }
  | {
      kind: 'summary'
      updated: number
      failures: BulkUpdateFailure[]
      heldBack: UpdateItem[]
      cancelled: boolean
    }

interface UpdateAllRegionProps {
  /** Every Skill currently behind, across all enabled Registries. */
  items: UpdateItem[]
  phase: UpdateAllPhase
  /** True while any other operation (refresh, install, a run itself) is busy. */
  disabled: boolean
  onRunAll: () => void
  /**
   * Requests cancellation of the in-flight run. The item currently being
   * updated always runs to completion; the run stops before the next
   * dispatch.
   */
  onCancel: () => void
  onDismissSummary: () => void
  /** One entry per stale Registry contributing behind Skills; empty otherwise. */
  disclosures: StaleRegistryDisclosure[]
  /** The single run-level stale-Registry acknowledgement; defaults to off. */
  acknowledgeStale: boolean
  onAcknowledgeStale: (on: boolean) => void
}

/**
 * The run region for "Update all": above the Catalogue rows, inside the
 * Catalogue pane. Hidden entirely in the idle state when nothing is behind.
 */
export function UpdateAllRegion({
  items,
  phase,
  disabled,
  onRunAll,
  onCancel,
  onDismissSummary,
  disclosures,
  acknowledgeStale,
  onAcknowledgeStale,
}: UpdateAllRegionProps): JSX.Element | null {
  if (phase.kind === 'idle' && items.length === 0) return null

  return (
    <div className="update-all" role="region" aria-label="Update all">
      {phase.kind === 'idle' ? (
        <>
          <div className="update-all-idle">
            <span className="update-all-count">
              {items.length === 1 ? '1 skill has an update' : `${items.length} skills have updates`}
            </span>
            <StaleDisclosures
              disclosures={disclosures}
              acknowledgeStale={acknowledgeStale}
              onAcknowledgeStale={onAcknowledgeStale}
            />
          </div>
          <button
            type="button"
            className="primary update-all-run"
            disabled={disabled}
            onClick={onRunAll}
          >
            Update all ({items.length})
          </button>
        </>
      ) : null}

      {phase.kind === 'refreshing' ? (
        <>
          <span className="update-all-progress" role="status" aria-live="polite">
            Checking for updates…
          </span>
          <button type="button" className="secondary update-all-cancel" onClick={onCancel}>
            Cancel run
          </button>
        </>
      ) : null}

      {phase.kind === 'updating' ? (
        <>
          <span className="update-all-progress" role="status" aria-live="polite">
            Updating {phase.item.name} — {phase.index + 1} of {phase.total}
          </span>
          <button type="button" className="secondary update-all-cancel" onClick={onCancel}>
            Cancel run
          </button>
        </>
      ) : null}

      {phase.kind === 'failed' ? (
        <>
          <p className="update-all-failed-reason" role="alert">
            {phase.reason}
          </p>
          <button
            type="button"
            className="primary update-all-run"
            disabled={disabled}
            onClick={onRunAll}
          >
            Update all ({items.length})
          </button>
        </>
      ) : null}

      {phase.kind === 'summary' ? (
        <div className="update-all-summary" role="status" aria-live="polite">
          {phase.cancelled ? <p className="update-all-cancelled">Run cancelled</p> : null}
          <p className="update-all-summary-line">
            {phase.updated} updated
            {phase.failures.length > 0 ? ` · ${phase.failures.length} failed` : ''}
            {phase.heldBack.length > 0 ? ` · ${phase.heldBack.length} held back` : ''}
          </p>
          {phase.failures.length > 0 ? (
            <ul className="update-all-failures">
              {phase.failures.map((failure) => (
                <li key={failure.item.skillId}>
                  {failure.item.name}: {failure.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <HeldBackList items={phase.heldBack} disclosures={disclosures} />
          <button
            type="button"
            className="secondary-action update-all-dismiss"
            onClick={onDismissSummary}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}
