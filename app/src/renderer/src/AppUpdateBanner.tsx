import type { JSX } from 'react'
import type { AppUpdateState } from '../../shared/ipc'

interface AppUpdateBannerProps {
  state: AppUpdateState | null
  onRestart: () => void
  onDownload: () => void
  restartDisabled?: boolean
}

export function AppUpdateBanner({
  state,
  onRestart,
  onDownload,
  restartDisabled = false,
}: AppUpdateBannerProps): JSX.Element | null {
  if (!state || state.kind === 'idle' || state.kind === 'checking') return null
  const waiting = state.kind === 'ready' && (state.waiting || restartDisabled)
  return (
    <section className="banner" aria-label="App Update">
      <div role="status" aria-live="polite">
        {state.kind === 'ready' ? (
          <>
            Version {state.version} is ready —{' '}
            <button
              type="button"
              className="secondary-action"
              disabled={waiting}
              onClick={onRestart}
            >
              {waiting ? 'Finishing current task…' : 'Restart to update'}
            </button>
          </>
        ) : state.kind === 'downloading' ? (
          <>
            Downloading version {state.version}: {Math.round(state.percent)}%
            <progress aria-label="App Update download" value={state.percent} max={100} />
          </>
        ) : (
          <>
            Version {state.version} is available.{' '}
            {state.kind === 'download-failed' ? <span>{state.message} </span> : null}
            <button type="button" className="secondary-action" onClick={onDownload}>
              {state.kind === 'download-failed' ? 'Retry' : 'Download'}
            </button>
          </>
        )}
      </div>
    </section>
  )
}
