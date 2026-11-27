import type { JSX } from 'react'
import type { InstallTargetId, InstallTargetStatus } from '../../shared/ipc'
import type { BulkInstallFailure, InstallItem, InstallWork } from './bulkInstall'
import type { BulkUninstallFailure, UninstallItem } from './bulkUninstall'
import type { StaleRegistryDisclosure } from './cataloguePresentation'
import { HeldBackList, StaleDisclosures } from './StaleDisclosures'

export type SelectionPhase =
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
  | { kind: 'uninstalling'; index: number; total: number; item: UninstallItem }
  | {
      kind: 'uninstall-summary'
      uninstalled: number
      failures: BulkUninstallFailure[]
      cancelled: boolean
    }

interface SelectionBarProps {
  count: number
  work: InstallWork
  /** The selected Skills installed in a chosen target; m on the Uninstall button. */
  uninstallItems: UninstallItem[]
  phase: SelectionPhase
  targets: InstallTargetStatus[]
  chosenTargets: InstallTargetId[]
  /** True while any other operation is busy. */
  busy: boolean
  acknowledgeStale: boolean
  onAcknowledgeStale: (on: boolean) => void
  replace: boolean
  onReplace: (on: boolean) => void
  onToggleTarget: (target: InstallTargetId) => void
  onClear: () => void
  onInstall: () => void
  onUninstall: () => void
  onCancel: () => void
  onDismiss: () => void
}

/**
 * Shown above the Catalogue rows in place of "Update all" while two or more
 * skills are selected, and while a bulk install or uninstall run or its
 * summary shows.
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

      {phase.kind === 'uninstalling' ? (
        <>
          <span className="update-all-progress" role="status" aria-live="polite">
            Uninstalling {phase.item.name} — {phase.index + 1} of {phase.total}
          </span>
          <button type="button" className="secondary update-all-cancel" onClick={props.onCancel}>
            Cancel run
          </button>
        </>
      ) : null}

      {phase.kind === 'uninstall-summary' ? (
        <div className="update-all-summary" role="status" aria-live="polite">
          {phase.cancelled ? <p className="update-all-cancelled">Run cancelled</p> : null}
          <p className="update-all-summary-line">
            {phase.uninstalled} uninstalled · {phase.failures.length} failed
          </p>
          <FailureList failures={phase.failures} />
          <button
            type="button"
            className="secondary-action update-all-dismiss"
            onClick={props.onDismiss}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {phase.kind === 'summary' ? (
        <div className="update-all-summary" role="status" aria-live="polite">
          {phase.cancelled ? <p className="update-all-cancelled">Run cancelled</p> : null}
          <p className="update-all-summary-line">
            {phase.installed} installed · {phase.failures.length} failed · {phase.heldBack.length}{' '}
            held back
          </p>
          <FailureList failures={phase.failures} />
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

function FailureList({
  failures,
}: {
  failures: (BulkInstallFailure | BulkUninstallFailure)[]
}): JSX.Element | null {
  if (failures.length === 0) return null
  return (
    <ul className="update-all-failures">
      {failures.map((failure) => (
        <li key={failure.item.skillId}>
          {failure.item.name}: {failure.reason}
        </li>
      ))}
    </ul>
  )
}

function IdleBar({
  count,
  work,
  uninstallItems,
  targets,
  chosenTargets,
  busy,
  acknowledgeStale,
  onAcknowledgeStale,
  replace,
  onReplace,
  onToggleTarget,
  onClear,
  onInstall,
  onUninstall,
}: SelectionBarProps): JSX.Element {
  const n = work.items.length
  const collisions = work.skippedCollisions
  return (
    <>
      <div className="update-all-idle">
        <span className="update-all-count" role="status" aria-live="polite">
          {count} selected · {work.skipped} skipped
          {collisions > 0
            ? ` · ${collisions} ${collisions === 1 ? 'target' : 'targets'} skipped as collisions`
            : null}
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
        <label className="selection-replace">
          <input type="checkbox" checked={replace} onChange={(e) => onReplace(e.target.checked)} />
          Replace existing skills
        </label>
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
        className="secondary"
        disabled={busy || uninstallItems.length === 0}
        onClick={onUninstall}
      >
        Uninstall ({uninstallItems.length})
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
