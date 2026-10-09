import type { JSX, RefObject } from 'react'

interface ToolbarProps {
  title: string
  subtitle: string | null
  subtitleColour: string | null
  settingsOpen: boolean
  searchQuery: string
  searchRef: RefObject<HTMLInputElement | null>
  refreshDisabled: boolean
  onSearchChange: (query: string) => void
  onRefresh: () => void
}

export function Toolbar({
  title,
  subtitle,
  subtitleColour,
  settingsOpen,
  searchQuery,
  searchRef,
  refreshDisabled,
  onSearchChange,
  onRefresh,
}: ToolbarProps): JSX.Element {
  return (
    <header className="toolbar">
      <h1 className="toolbar-title">
        {title}
        {subtitle ? (
          <>
            {' · '}
            {subtitleColour ? (
              <span className="dot" style={{ background: subtitleColour }} aria-hidden="true" />
            ) : null}
            <span className="toolbar-subtitle" title={subtitle}>
              {subtitle}
            </span>
          </>
        ) : null}
      </h1>
      {settingsOpen ? null : (
        <>
          <div className="search-field">
            <input
              ref={searchRef}
              className="search"
              type="search"
              placeholder="Search skills"
              aria-label="Search skills"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            <kbd className="kbd search-hint">⌘K</kbd>
          </div>
        </>
      )}
      <span className="toolbar-spacer" />
      <button
        type="button"
        className="toolbar-button"
        onClick={onRefresh}
        disabled={refreshDisabled}
        aria-label={settingsOpen ? undefined : 'Refresh catalogue'}
      >
        {settingsOpen ? 'Sync all' : 'Refresh'}
      </button>
    </header>
  )
}
