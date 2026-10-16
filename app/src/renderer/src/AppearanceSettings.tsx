import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppearanceApi, Theme } from '../../shared/ipc'

const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function AppearanceSettings({ api }: { api: AppearanceApi }): JSX.Element {
  const [theme, setTheme] = useState<Theme | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api
      .getAppearance()
      .then((appearance) => {
        if (active) setTheme(appearance.theme)
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause))
      })
    return () => {
      active = false
    }
  }, [api])

  async function choose(next: Theme): Promise<void> {
    if (theme === null || saving || next === theme) return
    setSaving(true)
    setError(null)
    try {
      await api.setTheme(next)
      setTheme(next)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section" aria-label="Appearance">
      <h2 className="settings-subtitle">Appearance</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label" id="appearance-theme-label">
              Theme
            </span>
            <span className="settings-row-detail">System follows macOS light and dark mode</span>
          </div>
          <div className="segmented" role="radiogroup" aria-labelledby="appearance-theme-label">
            {THEME_OPTIONS.map((option) => (
              <label key={option.id} className="segmented-option">
                <input
                  type="radio"
                  name="appearance-theme"
                  value={option.id}
                  checked={theme === option.id}
                  disabled={theme === null || saving}
                  onChange={() => void choose(option.id)}
                />
                {option.label}
              </label>
            ))}
          </div>
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
