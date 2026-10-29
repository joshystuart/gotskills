import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { RendererApi } from '../../shared/ipc'

export function SyncSettings({ api }: { api: RendererApi }): JSX.Element {
  const [value, setValue] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void api
      .getSyncConcurrency()
      .then((stored) => {
        if (active) setValue(stored)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [api])

  async function save(next: number): Promise<void> {
    if (!Number.isInteger(next) || next < 1 || next > 8 || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.setSyncConcurrency(next)
      setValue(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section" aria-label="Registry sync settings">
      <h2 className="settings-subtitle">Registry sync</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label">Simultaneous syncs</span>
            <span className="settings-row-detail">
              Applies the next time all registries sync. Choose 1 to sync one at a time.
            </span>
          </span>
          <input
            className="field-input"
            type="number"
            aria-label="Simultaneous syncs"
            min={1}
            max={8}
            step={1}
            value={value ?? ''}
            disabled={value === null || saving}
            onChange={(event) => void save(event.target.valueAsNumber)}
          />
        </label>
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
