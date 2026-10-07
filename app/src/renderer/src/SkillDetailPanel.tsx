import type { JSX, ReactNode } from 'react'
import type {
  InstallResult,
  InstallTargetId,
  InstallTargetStatus,
  SkillSummary,
} from '../../shared/ipc'
import { shortSha } from '../../shared/shortSha'
import {
  formatUpdatedAt,
  staleSkillNotice,
  targetLabel,
  targetState,
  targetStateLabel,
} from './cataloguePresentation'

interface InstallActions {
  visible: boolean
  disabled: boolean
  installing: boolean
  updateTargets: InstallTargetId[]
  onInstall: (targets: InstallTargetId[]) => void
  onUpdate: (targets: InstallTargetId[]) => void
}

interface RepairRemove {
  repairTargets: InstallTargetId[]
  repairDisabled: boolean
  removeTargets: InstallTargetId[]
  removeDisabled: boolean
  onRepair: (targets: InstallTargetId[]) => void
  onRemove: (targets: InstallTargetId[]) => void
}

interface SkillDetailPanelProps {
  skill: SkillSummary
  targets: InstallTargetStatus[]
  installedOnly: boolean
  installActions: InstallActions
  repairRemove: RepairRemove
  fileViewerOpen: boolean
  acknowledgedStale: boolean
  installError: string | null
  lastInstall: InstallResult | null
  filesSection: ReactNode
  onAcknowledgedStaleChange: (acknowledged: boolean) => void
  onClose: () => void
}

export function SkillDetailPanel({
  skill,
  targets,
  installedOnly,
  installActions,
  repairRemove,
  fileViewerOpen,
  acknowledgedStale,
  installError,
  lastInstall,
  filesSection,
  onAcknowledgedStaleChange,
  onClose,
}: SkillDetailPanelProps): JSX.Element {
  const lacking = targets
    .map((target) => target.id)
    .filter((target) => targetState(skill, target) === 'not-installed')
  const mainAction =
    lacking.length > 0
      ? {
          idle: 'Install to all',
          busy: 'Installing…',
          run: () => installActions.onInstall(lacking),
        }
      : installActions.updateTargets.length > 0
        ? {
            idle: 'Update',
            busy: 'Updating…',
            run: () => installActions.onUpdate(installActions.updateTargets),
          }
        : null
  const targetActions = (target: InstallTargetStatus) => {
    const state = targetState(skill, target.id)
    return [
      {
        text: 'Install',
        label: `Install to ${target.label}`,
        shown: installActions.visible && state === 'not-installed',
        disabled: installActions.disabled,
        run: installActions.onInstall,
      },
      {
        text: 'Update',
        label: `Update ${target.label}`,
        shown: !installedOnly && state === 'update-available',
        disabled: repairRemove.repairDisabled,
        run: installActions.onUpdate,
      },
      {
        text: 'Repair',
        label: `Repair ${target.label}`,
        shown: !installedOnly && state === 'needs-repair',
        disabled: repairRemove.repairDisabled,
        run: repairRemove.onRepair,
      },
      {
        text: 'Remove',
        label: `Remove from ${target.label}`,
        shown: repairRemove.removeTargets.includes(target.id),
        disabled: repairRemove.removeDisabled,
        run: repairRemove.onRemove,
      },
    ]
  }

  return (
    <section className="pane detail" aria-label="Skill detail">
      <div className="pane-body detail-body">
        <div className="detail-hero">
          <div className="detail-hero-copy">
            <div className="detail-top">
              <p className="detail-eyebrow">
                {[
                  skill.registryLabel,
                  formatUpdatedAt(skill.updatedAt),
                  skill.orphaned ? 'Source removed' : null,
                  !skill.orphaned && installedOnly ? 'Source disabled' : null,
                  skill.softDeleted ? 'Removed from registry' : null,
                ]
                  .filter((part): part is string => part !== null && part !== undefined)
                  .join(' · ')}
              </p>
              <button
                type="button"
                className="detail-close"
                aria-label="Close skill detail"
                onClick={onClose}
              >
                ✕
              </button>
            </div>
            <h1 className="detail-title">
              {skill.name}
              {skill.conflict ? (
                <span className="skill-conflict detail-conflict" title="Skill Conflict">
                  Conflict
                </span>
              ) : null}
            </h1>
            <p className="detail-desc">{skill.description}</p>
            <dl className="detail-chips" aria-label="Skill identity">
              <div className="detail-chip">
                <dt>ID</dt>
                <dd>{skill.id}</dd>
              </div>
              {shortSha(skill.latestVersion, null) ? (
                <div className="detail-chip">
                  <dt>Revision</dt>
                  <dd>{shortSha(skill.latestVersion, null)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
          <div className="detail-actions">
            {installActions.visible && mainAction ? (
              <button
                type="button"
                className="primary install-primary"
                disabled={installActions.disabled}
                onClick={mainAction.run}
              >
                {installActions.installing ? mainAction.busy : mainAction.idle}
              </button>
            ) : null}
            {!installedOnly && repairRemove.repairTargets.length > 0 ? (
              <button
                type="button"
                className="secondary-action"
                disabled={repairRemove.repairDisabled}
                onClick={() => repairRemove.onRepair(repairRemove.repairTargets)}
              >
                Repair
              </button>
            ) : null}
            {repairRemove.removeTargets.length > 0 ? (
              <button
                type="button"
                className="secondary-action"
                disabled={repairRemove.removeDisabled}
                onClick={() => repairRemove.onRemove(repairRemove.removeTargets)}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>

        {!fileViewerOpen ? (
          <>
            {skill.stale ? (
              <div className="stale-notice" role="note">
                <p className="stale-notice-text">{staleSkillNotice(skill)}</p>
                <label className="stale-ack">
                  <input
                    type="checkbox"
                    checked={acknowledgedStale}
                    onChange={(e) => onAcknowledgedStaleChange(e.target.checked)}
                    aria-label="Acknowledge stale snapshot"
                  />
                  <span>Install or update from this stale snapshot anyway</span>
                </label>
              </div>
            ) : null}

            {installedOnly ? (
              <p className="installed-only-note">
                {skill.orphaned
                  ? 'This skill’s registry was removed. It stays installed and can be uninstalled, but updates are unavailable.'
                  : 'This skill’s registry is disabled. It stays installed and can be uninstalled, but updates are unavailable.'}
              </p>
            ) : null}

            {installError ? (
              <p className="install-error" role="alert">
                {installError}
              </p>
            ) : null}

            {lastInstall ? (
              <ul className="install-results" aria-label="Install results">
                {lastInstall.perTarget.map((tr) => (
                  <li key={tr.target}>
                    <span className="glyph" aria-hidden="true">
                      {tr.outcome === 'installed' ? '✓' : '×'}
                    </span>
                    {targetLabel(targets, tr.target)}:{' '}
                    {tr.outcome === 'installed'
                      ? `installed (${tr.method})`
                      : (tr.error ?? tr.outcome)}
                  </li>
                ))}
              </ul>
            ) : null}

            <section className="on-this-mac" aria-label="On this Mac">
              <h2 className="on-this-mac-title">On this Mac</h2>
              <div className="facts">
                {targets.map((target) => {
                  const st = targetStateLabel(skill, target.id)
                  const installed = skill.perTarget.find((p) => p.target === target.id)
                  const showLatest = skill.latestVersion && !skill.softDeleted && !installedOnly
                  const behind = showLatest && installed?.installedVersion !== skill.latestVersion
                  return (
                    <div className="fact" key={target.id}>
                      <div className="fact-main">
                        <span className="fact-label" title={target.id}>
                          {target.label}
                        </span>
                        <span className="fact-state">
                          <span className="glyph" aria-hidden="true">
                            {st.glyph}
                          </span>{' '}
                          {st.text}
                          {installed?.installedVersion ? (
                            <>
                              {' · '}
                              <span className="mono">{installed.installedVersion}</span>
                              {behind ? (
                                <>
                                  {' → '}
                                  <span className="mono">{skill.latestVersion}</span>
                                </>
                              ) : null}
                            </>
                          ) : showLatest ? (
                            <>
                              {' · latest '}
                              <span className="mono">{skill.latestVersion}</span>
                            </>
                          ) : null}
                        </span>
                      </div>
                      <span className="fact-actions">
                        {targetActions(target)
                          .filter((action) => action.shown)
                          .map((action) => (
                            <button
                              key={action.text}
                              type="button"
                              className="fact-action"
                              aria-label={action.label}
                              disabled={action.disabled}
                              onClick={() => action.run([target.id])}
                            >
                              {action.text}
                            </button>
                          ))}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          </>
        ) : null}

        {filesSection}
      </div>
    </section>
  )
}
