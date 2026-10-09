import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import {
  MAX_REGISTRY_NAME_LENGTH,
  type RegistryRecord,
  type SupportedAgent,
} from '../../shared/ipc'
import {
  ACCESS_REQUIRED_GUIDANCE,
  ACCESS_REQUIRED_TITLE,
  registryDotColour,
  automaticRegistryRecordName,
  registryRecordLabel,
  registryStatusLabel,
} from './cataloguePresentation'

interface RegistryEditForm {
  editingId: string | null
  url: string
  branch: string
  name: string
  branchWarn: boolean
  onUrlChange: (url: string) => void
  onBranchChange: (branch: string) => void
  onNameChange: (name: string) => void
  onStart: (registry: RegistryRecord) => void
  onCancel: () => void
  onAttempt: (event: FormEvent, registry: RegistryRecord) => void
  onCommit: (registry: RegistryRecord) => void
}

interface AddRegistryForm {
  url: string
  branch: string
  busy: boolean
  error: string | null
  onUrlChange: (url: string) => void
  onBranchChange: (branch: string) => void
  onSubmit: (event: FormEvent) => void
}

interface SettingsViewProps {
  registries: RegistryRecord[]
  agents: SupportedAgent[]
  appUpdateSettings: JSX.Element
  registryBusy: boolean
  registryError: string | null
  highlightedRegistryId: string | null
  editForm: RegistryEditForm
  addForm: AddRegistryForm
  onToggleEnabled: (registry: RegistryRecord) => void
  onToggleAutoUpdate: (registry: RegistryRecord) => void
  onChangeColour: (registry: RegistryRecord, colour: string) => Promise<void>
  onSyncRegistry: (registry: RegistryRecord) => void
  onRemoveRegistry: (registry: RegistryRecord) => void
}

type SyncTone = 'ok' | 'fail' | 'idle'

function isAccessRequired(registry: RegistryRecord): boolean {
  return registry.syncStatus.phase === 'failed' && registry.syncStatus.reason === 'access-required'
}

function rowSyncState(registry: RegistryRecord): { tone: SyncTone; text: string } {
  if (!registry.enabled) return { tone: 'idle', text: 'Disabled — installed skills stay visible' }
  const { phase, stale } = registry.syncStatus
  if (isAccessRequired(registry)) {
    return { tone: 'fail', text: stale ? 'Sync failed — showing last snapshot' : 'Sync failed' }
  }
  const tone: SyncTone = phase === 'failed' ? 'fail' : phase === 'synced' ? 'ok' : 'idle'
  return { tone, text: registryStatusLabel(registry.syncStatus).text }
}

function skillCountLabel(count: number): string {
  return count === 1 ? '1 skill' : `${count} skills`
}

function RegistryDot({ registry }: { registry: RegistryRecord }): JSX.Element {
  return (
    <span className="dot" style={{ background: registryDotColour(registry) }} aria-hidden="true" />
  )
}

interface RegistryColourPickerProps {
  registry: RegistryRecord
  name: string
  onChangeColour: (registry: RegistryRecord, colour: string) => Promise<void>
}

/** The picker's native change event fires once on close; React's onChange fires on every drag. */
function RegistryColourPicker({
  registry,
  name,
  onChangeColour,
}: RegistryColourPickerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const savedColour = registryDotColour(registry)
  const [preview, setPreview] = useState<string | null>(null)
  const colour = preview ?? savedColour

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const commit = (): void => {
      void onChangeColour(registry, input.value).finally(() => setPreview(null))
    }
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [registry, onChangeColour])

  return (
    <>
      <button
        type="button"
        className="dot-button"
        aria-label={`Change colour for ${name}`}
        onClick={() => inputRef.current?.click()}
      >
        <span className="dot" style={{ background: colour }} aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        className="sr-only"
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        aria-label={`Colour for ${name}`}
        value={colour}
        onChange={(e) => setPreview(e.target.value)}
      />
    </>
  )
}

interface RegistryRowProps {
  registry: RegistryRecord
  registryBusy: boolean
  highlighted: boolean
  onStartEdit: (registry: RegistryRecord) => void
  onToggleEnabled: (registry: RegistryRecord) => void
  onToggleAutoUpdate: (registry: RegistryRecord) => void
  onChangeColour: (registry: RegistryRecord, colour: string) => Promise<void>
  onSyncRegistry: (registry: RegistryRecord) => void
  onRemoveRegistry: (registry: RegistryRecord) => void
}

function RegistryRow({
  registry,
  registryBusy,
  highlighted,
  onStartEdit,
  onToggleEnabled,
  onToggleAutoUpdate,
  onChangeColour,
  onSyncRegistry,
  onRemoveRegistry,
}: RegistryRowProps): JSX.Element {
  const name = registryRecordLabel(registry)
  const syncState = rowSyncState(registry)
  const accessRequired = isAccessRequired(registry)
  const skillCount = registry.syncStatus.visibleSkillCount
  const rowRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [highlighted])

  return (
    <li
      ref={rowRef}
      className={[
        'registry-item',
        registry.enabled ? null : 'off',
        highlighted ? 'highlighted' : null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="registry-info">
        <div className="registry-name">
          {registry.enabled ? (
            <RegistryColourPicker registry={registry} name={name} onChangeColour={onChangeColour} />
          ) : (
            <RegistryDot registry={registry} />
          )}
          <span className="registry-label">{name}</span>
        </div>
        <div className="registry-url mono">{registry.url}</div>
        <div className="registry-meta">
          <span className="chip">
            branch <b>{registry.branch}</b>
          </span>
          {skillCount === undefined ? null : <span>{skillCountLabel(skillCount)}</span>}
          <span className={`registry-sync ${syncState.tone}`}>{syncState.text}</span>
        </div>
        {accessRequired ? (
          <p className="callout error">
            <strong>{ACCESS_REQUIRED_TITLE}</strong>. {ACCESS_REQUIRED_GUIDANCE}
          </p>
        ) : null}
      </div>
      <div className="registry-actions">
        <button
          type="button"
          className={accessRequired ? 'secondary' : 'secondary-action'}
          aria-label={`Sync ${name}`}
          disabled={registryBusy || !registry.enabled}
          onClick={() => onSyncRegistry(registry)}
        >
          Sync
        </button>
        <button
          type="button"
          className="secondary-action"
          aria-label={`Edit ${name}`}
          onClick={() => onStartEdit(registry)}
        >
          Edit
        </button>
        <button
          type="button"
          className="danger-action"
          aria-label={`Remove ${name}`}
          disabled={registryBusy}
          onClick={() => onRemoveRegistry(registry)}
        >
          Remove
        </button>
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={registry.enabled}
        aria-label={`${name} enabled`}
        disabled={registryBusy}
        onClick={() => onToggleEnabled(registry)}
      />
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={registry.autoUpdate}
        aria-label={`${name} auto update`}
        disabled={registryBusy || !registry.enabled}
        onClick={() => onToggleAutoUpdate(registry)}
      />
    </li>
  )
}

interface RegistryEditRowProps {
  registry: RegistryRecord
  registryBusy: boolean
  form: RegistryEditForm
}

function RegistryEditRow({ registry, registryBusy, form }: RegistryEditRowProps): JSX.Element {
  const name = registryRecordLabel(registry)

  return (
    <li className="registry-item editing">
      <div className="registry-name">
        <RegistryDot registry={registry} />
        <span className="registry-label">{name}</span>
        <span className="badge">Editing</span>
      </div>
      <form
        className="registry-edit"
        aria-label={`Edit ${name}`}
        onSubmit={(e) => form.onAttempt(e, registry)}
      >
        <div className="fields">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              type="text"
              value={form.name}
              placeholder={automaticRegistryRecordName(registry)}
              maxLength={MAX_REGISTRY_NAME_LENGTH}
              onChange={(e) => form.onNameChange(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">Registry URL</span>
            <input
              className="field-input"
              type="text"
              value={form.url}
              onChange={(e) => form.onUrlChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Branch</span>
            <input
              className="field-input"
              type="text"
              value={form.branch}
              onChange={(e) => form.onBranchChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        {form.branchWarn ? (
          <p className="callout warn" role="alert">
            Changing the branch changes the update source for skills already installed from this
            registry. Installed skills stay put; future updates come from the new branch.
          </p>
        ) : null}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={form.onCancel}>
            Cancel
          </button>
          {form.branchWarn ? (
            <button
              type="button"
              className="secondary"
              disabled={registryBusy}
              onClick={() => form.onCommit(registry)}
            >
              Change branch anyway
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={registryBusy}>
            Save
          </button>
        </div>
      </form>
    </li>
  )
}

type AgentFilter = 'all' | 'detected' | 'not-detected'

const AGENT_FILTERS: { id: AgentFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'detected', label: 'Detected' },
  { id: 'not-detected', label: 'Not detected' },
]

function matchesFilter(agent: SupportedAgent, filter: AgentFilter): boolean {
  if (filter === 'all') return true
  return agent.detected === (filter === 'detected')
}

function matchesQuery(agent: SupportedAgent, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return (
    agent.displayName.toLowerCase().includes(needle) || agent.target.toLowerCase().includes(needle)
  )
}

function AgentsSection({ agents }: { agents: SupportedAgent[] }): JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AgentFilter>('detected')
  const searched = agents.filter((agent) => matchesQuery(agent, query))
  const shown = searched.filter((agent) => matchesFilter(agent, filter))

  return (
    <section className="settings-section" aria-label="Agents">
      <h2 className="settings-subtitle">Agents</h2>
      <p className="settings-lead">
        Every agent Got Skills can install to, and the folder it installs into. An agent's folder
        appears in the catalogue once the agent is detected on this Mac, or while it still holds
        skills the app installed.
      </p>
      <div className="agent-panel">
        <div className="agent-toolbar">
          <input
            className="field-input agent-search"
            type="search"
            aria-label="Search agents"
            placeholder="Search agents or folders"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="agent-filters" role="group" aria-label="Filter agents">
            {AGENT_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="agent-filter"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                <span className="agent-filter-count">
                  {searched.filter((agent) => matchesFilter(agent, option.id)).length}
                </span>
              </button>
            ))}
          </div>
        </div>
        {shown.length > 0 ? (
          <ul className="agent-list" role="list">
            {shown.map((agent) => (
              <li key={agent.id} className="agent-item" aria-label={agent.displayName}>
                <span className="agent-name">{agent.displayName}</span>
                <span className="agent-folder mono">{agent.target}</span>
                <span className={agent.detected ? 'agent-detected on' : 'agent-detected'}>
                  {agent.detected ? 'Detected' : 'Not detected'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agent-empty">No agents match.</p>
        )}
      </div>
    </section>
  )
}

export function SettingsView({
  registries,
  agents,
  appUpdateSettings,
  registryBusy,
  registryError,
  highlightedRegistryId,
  editForm,
  addForm,
  onToggleEnabled,
  onToggleAutoUpdate,
  onChangeColour,
  onSyncRegistry,
  onRemoveRegistry,
}: SettingsViewProps): JSX.Element {
  return (
    <main className="settings" aria-label="Settings">
      <div className="settings-panel">
        {appUpdateSettings}
        <section className="settings-section" aria-label="Registries">
          <h2 className="settings-subtitle">Registries</h2>
          <p className="settings-lead">
            Registries supply skills to the combined catalogue. Private GitHub registries are
            accessed over HTTPS using credentials already available to system Git — the app never
            stores a token or account.
          </p>
          <ul className="registry-list" role="list">
            {registries.length > 0 ? (
              <li className="registry-columns" aria-hidden="true">
                <span title="Include this registry's skills in the catalogue">Enabled</span>
                <span title="Update installed skills after each sync">Auto-update</span>
              </li>
            ) : null}
            {registries.map((registry) =>
              editForm.editingId === registry.id ? (
                <RegistryEditRow
                  key={registry.id}
                  registry={registry}
                  registryBusy={registryBusy}
                  form={editForm}
                />
              ) : (
                <RegistryRow
                  key={registry.id}
                  registry={registry}
                  registryBusy={registryBusy}
                  highlighted={highlightedRegistryId === registry.id}
                  onStartEdit={editForm.onStart}
                  onToggleEnabled={onToggleEnabled}
                  onToggleAutoUpdate={onToggleAutoUpdate}
                  onChangeColour={onChangeColour}
                  onSyncRegistry={onSyncRegistry}
                  onRemoveRegistry={onRemoveRegistry}
                />
              )
            )}
          </ul>
          {registryError ? (
            <p className="settings-error" role="alert">
              {registryError}
            </p>
          ) : null}
        </section>

        <section className="settings-section" aria-label="Add registry">
          <h2 className="settings-subtitle">Add a registry</h2>
          <p className="settings-lead">
            Any Git repository containing <span className="mono">SKILL.md</span> files.
          </p>
          <form className="settings-card add-registry" onSubmit={addForm.onSubmit}>
            <div className="fields">
              <label className="field">
                <span className="field-label">New registry URL</span>
                <input
                  className="field-input"
                  type="text"
                  value={addForm.url}
                  onChange={(e) => addForm.onUrlChange(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span className="field-label">New registry branch</span>
                <input
                  className="field-input"
                  type="text"
                  value={addForm.branch}
                  onChange={(e) => addForm.onBranchChange(e.target.value)}
                  placeholder="auto-detect"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
            {addForm.error ? (
              <p className="settings-error" role="alert">
                {addForm.error}
              </p>
            ) : null}
            <div className="form-actions add-actions">
              <span className="hint">Branch is detected automatically when possible.</span>
              <button
                type="submit"
                className="primary"
                disabled={addForm.busy || !addForm.url.trim()}
              >
                {addForm.busy ? 'Adding…' : 'Add registry'}
              </button>
            </div>
          </form>
        </section>

        <AgentsSection agents={agents} />
      </div>
    </main>
  )
}
