import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppUpdateApi, AppUpdateState } from '../../shared/ipc'

export function AppUpdateSettings({
  api,
  state,
}: {
  api: AppUpdateApi
  state: AppUpdateState | null
}): JSX.Element {
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void api
      .getAutoDownloadAppUpdates()
      .then((enabled) => {
        if (active) setAutoDownload(enabled)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [api])

  async function toggle(): Promise<void> {
    if (autoDownload === null || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.setAutoDownloadAppUpdates(!autoDownload)
      setAutoDownload(!autoDownload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section" aria-label="App Update settings">
      <h2 className="settings-subtitle">App Update</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">
              Current version: {state?.currentVersion ?? 'Loading…'}
            </span>
            {state?.kind === 'idle' && state.lastCheck ? (
              <span
                role="status"
                className={
                  state.lastCheck.result === 'error' ? 'settings-error' : 'settings-row-detail'
                }
              >
                {state.lastCheck.result === 'up-to-date'
                  ? 'You’re up to date'
                  : state.lastCheck.message}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={
              !state ||
              state.kind === 'checking' ||
              state.kind === 'downloading' ||
              state.kind === 'ready'
            }
            onClick={() => void api.checkAppUpdate()}
          >
            {state?.kind === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Download app updates automatically</span>
            <span className="settings-row-detail">
              New versions install the next time you restart
            </span>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-label="Download app updates automatically"
            aria-checked={autoDownload ?? true}
            disabled={autoDownload === null || saving}
            onClick={() => void toggle()}
          />
        </div>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
