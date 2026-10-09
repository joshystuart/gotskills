import type { JSX } from 'react'
import type { InstallTargetId, InstallTargetStatus } from '../../shared/ipc'
import type { BulkInstallFailure, InstallItem, InstallWork } from './bulkInstall'
import type { StaleRegistryDisclosure } from './cataloguePresentation'
import { HeldBackList, StaleDisclosures } from './StaleDisclosures'

export type BulkInstallPhase =
  | { kind: 'idle' }
  | { kind: 'installing'; index: number; total: number; item: InstallItem }
  | {
      kind: 'summary'
      installed: number
      failures: BulkInstallFailure[]
      heldBack: InstallItem[]
      /** The stale-Registry disclosures captured when the run started. */
      disclosures: StaleRegistryDisclosure[]
      cancelled: boolean
    }

interface SelectionBarProps {
  count: number
  work: InstallWork
  phase: BulkInstallPhase
  targets: InstallTargetStatus[]
  chosenTargets: InstallTargetId[]
  /** True while any other operation is busy. */
  busy: boolean
  acknowledgeStale: boolean
  onAcknowledgeStale: (on: boolean) => void
  onToggleTarget: (target: InstallTargetId) => void
  onClear: () => void
  onInstall: () => void
  onCancel: () => void
  onDismiss: () => void
}

/**
 * Shown above the Catalogue rows in place of "Update all" while two or more
 * skills are selected, and while a bulk install run or its summary shows.
 */
export function SelectionBar(props: SelectionBarProps): JSX.Element {
  const { phase } = props
  return (
    <div className="update-all selection-bar" role="region" aria-label="Selection">
      {phase.kind === 'idle' ? <IdleBar {...props} /> : null}

      {phase.kind === 'installing' ? (
        <>
          <span className="update-all-progress" role="status" aria-live="polite">
            Installing {phase.item.name} — {phase.index + 1} of {phase.total}
          </span>
          <button type="button" className="secondary update-all-cancel" onClick={props.onCancel}>
            Cancel run
          </button>
        </>
      ) : null}

      {phase.kind === 'summary' ? (
        <div className="update-all-summary" role="status" aria-live="polite">
          {phase.cancelled ? <p className="update-all-cancelled">Run cancelled</p> : null}
          <p className="update-all-summary-line">
            {phase.installed} installed · {phase.failures.length} failed · {phase.heldBack.length}{' '}
            held back
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
          <HeldBackList items={phase.heldBack} disclosures={phase.disclosures} />
          <button
            type="button"
            className="secondary-action update-all-dismiss"
            onClick={props.onDismiss}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

function IdleBar({
  count,
  work,
  targets,
  chosenTargets,
  busy,
  acknowledgeStale,
  onAcknowledgeStale,
  onToggleTarget,
  onClear,
  onInstall,
}: SelectionBarProps): JSX.Element {
  const n = work.items.length
  return (
    <>
      <div className="update-all-idle">
        <span className="update-all-count" role="status" aria-live="polite">
          {count} selected · {work.skipped} skipped
        </span>
        <div className="selection-chips">
          {targets.map((target) => (
            <label key={target.id} className="selection-chip">
              <input
                type="checkbox"
                checked={chosenTargets.includes(target.id)}
                onChange={() => onToggleTarget(target.id)}
              />
              {target.label}
            </label>
          ))}
        </div>
        <StaleDisclosures
          disclosures={work.disclosures}
          acknowledgeStale={acknowledgeStale}
          onAcknowledgeStale={onAcknowledgeStale}
        />
      </div>
      <button type="button" className="secondary" onClick={onClear}>
        Clear
      </button>
      <button
        type="button"
        className="primary update-all-run"
        disabled={busy || n === 0 || chosenTargets.length === 0}
        onClick={onInstall}
      >
        Install ({n})
      </button>
    </>
  )
}
