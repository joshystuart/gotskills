import type { JSX } from 'react'
import type { AutoUpdateResult } from '../../shared/ipc'

interface AutoUpdateNoticeProps {
  result: AutoUpdateResult
  onDismiss: () => void
}

export function AutoUpdateNotice({ result, onDismiss }: AutoUpdateNoticeProps): JSX.Element {
  return (
    <section className="update-all" aria-label={`Auto update from ${result.registryLabel}`}>
      <div className="update-all-summary" role="status" aria-live="polite">
        <p className="update-all-summary-line">
          Auto-updated {result.updated.length} {result.updated.length === 1 ? 'skill' : 'skills'}{' '}
          from {result.registryLabel}
        </p>
        {result.failed.length > 0 ? (
          <ul className="update-all-failures">
            {result.failed.map((failure) => (
              <li key={failure.folderName}>
                {failure.name}: {failure.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="secondary-action update-all-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  )
}
