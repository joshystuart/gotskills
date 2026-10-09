import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import { MAX_REGISTRY_NAME_LENGTH, type RegistryRecord, type SyncStatus } from '../../shared/ipc'
import logoUrl from './assets/logo.svg'
import {
  CATALOGUE_VIEWS,
  formatLastSynced,
  automaticRegistryRecordName,
  registryDotColour,
  registryRecordLabel,
  syncLabel,
  viewLabel,
  type CatalogueView,
  type RegistryFilter,
} from './cataloguePresentation'

/** Tooltip for a sidebar Registry button: the friendly name, if set, before the automatic name. */
function registryButtonTitle(registry: RegistryRecord): string {
  const automatic = automaticRegistryRecordName(registry)
  return registry.name ? `${registry.name} — ${automatic}` : automatic
}

interface SidebarProps {
  status: SyncStatus | null
  view: CatalogueView
  counts: Record<CatalogueView, number>
  settingsOpen: boolean
  registries: RegistryRecord[]
  registryCounts: Map<string, number>
  registryFilter: RegistryFilter
  onSelectRegistry: (registryId: string) => void
  onRegistryMenu: (registry: RegistryRecord, position?: { x: number; y: number }) => Promise<void>
  renamingRegistryId: string | null
  onRenameRegistry: (registry: RegistryRecord, name: string) => Promise<void>
  onCancelRename: () => void
  onSelectView: (view: CatalogueView) => void
  onOpenSettings: () => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** In-place text input that renames a registry, Finder style. */
function RegistryRenameField({
  registry,
  onRename,
  onCancel,
}: {
  registry: RegistryRecord
  onRename: (registry: RegistryRecord, name: string) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const original = registryRecordLabel(registry)
  const [value, setValue] = useState(original)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  async function save(): Promise<void> {
    if (settled.current) return
    const name = value.trim()
    if (name === original) {
      settled.current = true
      onCancel()
      return
    }
    settled.current = true
    try {
      await onRename(registry, name)
    } catch (err) {
      settled.current = false
      setError(errorText(err))
    }
  }

  function cancel(): void {
    settled.current = true
    onCancel()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  return (
    <div className="nav-item nav-rename">
      <span className="nav-label">
        <span
          className="dot"
          style={{ background: registryDotColour(registry) }}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          className="nav-rename-input"
          aria-label="Registry name"
          maxLength={MAX_REGISTRY_NAME_LENGTH}
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void save()}
        />
      </span>
      {error ? (
        <span className="nav-rename-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function RegistryHealth({
  registry,
  count,
}: {
  registry: RegistryRecord
  count: number
}): JSX.Element {
  if (!registry.enabled) return <span className="nav-count">off</span>
  if (registry.syncStatus.phase === 'failed') {
    return (
      <span className="nav-failed" role="img" aria-label="Sync failed">
        ×
      </span>
    )
  }
  return <span className="nav-count">{count}</span>
}

export function Sidebar({
  status,
  view,
  counts,
  settingsOpen,
  registries,
  registryCounts,
  registryFilter,
  onSelectRegistry,
  onRegistryMenu,
  renamingRegistryId,
  onRenameRegistry,
  onCancelRename,
  onSelectView,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const label = status ? syncLabel(status) : { glyph: '↻', text: 'Loading…' }
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  async function openRegistryMenu(event: MouseEvent<HTMLButtonElement>, registry: RegistryRecord) {
    event.preventDefault()
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    const rect = event.currentTarget.getBoundingClientRect()
    setMenuOpenId(registry.id)
    try {
      await onRegistryMenu(registry, fromKeyboard ? { x: rect.left, y: rect.bottom } : undefined)
    } finally {
      setMenuOpenId(null)
    }
  }

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt="" aria-hidden="true" />
          <span className="wordmark">Got Skills</span>
        </div>
      </div>

      <nav className="nav" aria-label="Views">
        {CATALOGUE_VIEWS.map((id) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            aria-current={!settingsOpen && view === id ? 'page' : undefined}
            onClick={() => onSelectView(id)}
          >
            <span>{viewLabel(id)}</span>{' '}
            {id === 'updates' ? (
              counts[id] > 0 ? (
                <span className="nav-badge">{counts[id]}</span>
              ) : null
            ) : (
              <span className="nav-count">{counts[id]}</span>
            )}
          </button>
        ))}
      </nav>

      {registries.length > 0 ? (
        <nav className="nav" aria-labelledby="sidebar-registries-label">
          <h2 id="sidebar-registries-label" className="section-label">
            Registries
          </h2>
          {registries.map((registry) =>
            renamingRegistryId === registry.id ? (
              <RegistryRenameField
                key={registry.id}
                registry={registry}
                onRename={onRenameRegistry}
                onCancel={onCancelRename}
              />
            ) : (
              <button
                key={registry.id}
                type="button"
                className={[
                  'nav-item',
                  registry.enabled ? null : 'nav-item-off',
                  menuOpenId === registry.id ? 'menu-open' : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={registryFilter === registry.id}
                title={registryButtonTitle(registry)}
                onClick={() => onSelectRegistry(registry.id)}
                onContextMenu={(event) => void openRegistryMenu(event, registry)}
              >
                <span className="nav-label">
                  <span
                    className="dot"
                    style={{ background: registryDotColour(registry) }}
                    aria-hidden="true"
                  />
                  <span>{registryRecordLabel(registry)}</span>
                </span>{' '}
                <RegistryHealth registry={registry} count={registryCounts.get(registry.id) ?? 0} />
              </button>
            )
          )}
        </nav>
      ) : null}

      <div className="sidebar-foot">
        <div className="sync" role="status" aria-live="polite">
          <span className={`sync-badge sync-${status?.phase ?? 'loading'}`}>
            <span className="glyph" aria-hidden="true">
              {label.glyph}
            </span>
            {label.text}
          </span>
          <span className="sync-meta">{formatLastSynced(status?.lastSyncedAt ?? null)}</span>
        </div>
        <button
          type="button"
          className="nav-item"
          aria-label="Settings"
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={onOpenSettings}
        >
          <span>Settings</span>
          <kbd className="kbd">⌘,</kbd>
        </button>
      </div>
    </aside>
  )
}
