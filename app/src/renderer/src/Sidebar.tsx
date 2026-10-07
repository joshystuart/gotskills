import type { JSX } from 'react'
import type { RegistryRecord, SyncStatus } from '../../shared/ipc'
import logoUrl from './assets/logo.svg'
import {
  CATALOGUE_VIEWS,
  formatLastSynced,
  registryDotColour,
  registryRecordLabel,
  syncLabel,
  viewLabel,
  type CatalogueView,
  type RegistryFilter,
} from './cataloguePresentation'

interface SidebarProps {
  status: SyncStatus | null
  view: CatalogueView
  counts: Record<CatalogueView, number>
  settingsOpen: boolean
  registries: RegistryRecord[]
  registryCounts: Map<string, number>
  registryFilter: RegistryFilter
  onSelectRegistry: (registryId: string) => void
  onSelectView: (view: CatalogueView) => void
  onOpenSettings: () => void
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
  onSelectView,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const label = status ? syncLabel(status) : { glyph: '↻', text: 'Loading…' }

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
          {registries.map((registry) => (
            <button
              key={registry.id}
              type="button"
              className={registry.enabled ? 'nav-item' : 'nav-item nav-item-off'}
              aria-pressed={registryFilter === registry.id}
              onClick={() => onSelectRegistry(registry.id)}
            >
              <span className="nav-label">
                <span
                  className="dot"
                  style={{ background: registryDotColour(registry.id, registry.enabled) }}
                  aria-hidden="true"
                />
                <span>{registryRecordLabel(registry)}</span>
              </span>{' '}
              <RegistryHealth registry={registry} count={registryCounts.get(registry.id) ?? 0} />
            </button>
          ))}
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
