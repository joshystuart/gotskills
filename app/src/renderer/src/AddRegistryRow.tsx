import { useEffect, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { isLocalPath } from '../../shared/registryUrl'

export type AddRegistrySource = 'git' | 'folder'

export interface AddRegistryForm {
  source: AddRegistrySource | null
  url: string
  branch: string
  busy: boolean
  error: string | null
  onStartGit: () => void
  onChooseFolder: () => void
  onCancel: () => void
  onUrlChange: (url: string) => void
  onBranchChange: (branch: string) => void
  onSubmit: (event: FormEvent) => void
}

function BranchField({ form }: { form: AddRegistryForm }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (isLocalPath(form.url)) return null
  if (!open && !form.branch && !form.error) {
    return (
      <button type="button" className="add-branch-toggle" onClick={() => setOpen(true)}>
        Branch: <b>default</b> · change
      </button>
    )
  }
  return (
    <label className="field add-branch">
      <span className="field-label">Branch</span>
      <input
        className="field-input"
        type="text"
        aria-label="Repository branch"
        value={form.branch}
        onChange={(e) => form.onBranchChange(e.target.value)}
        placeholder="default branch"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  )
}

function AddRegistryMenu({ form }: { form: AddRegistryForm }): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <li className="add-registry-footer">
      <div className="add-menu-anchor">
        <button
          type="button"
          className="add-registry-button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          + Add registry
        </button>
        {open ? (
          <div className="add-menu" role="menu" aria-label="Add registry">
            <button type="button" role="menuitem" onClick={form.onStartGit}>
              Git repository…
              <span>GitHub or any Git URL</span>
            </button>
            <button type="button" role="menuitem" onClick={form.onChooseFolder}>
              Folder on this Mac…
              <span>
                A folder of <span className="mono">SKILL.md</span> files, watched for changes
              </span>
            </button>
          </div>
        ) : null}
      </div>
      {form.error ? (
        <p className="settings-error" role="alert">
          {form.error}
        </p>
      ) : null}
    </li>
  )
}

/** Foot of the registry list: an "Add registry" menu that opens the new entry as an inline row. */
export function AddRegistryRow({ form }: { form: AddRegistryForm }): JSX.Element {
  if (form.source === null) return <AddRegistryMenu form={form} />

  return (
    <li className="add-registry-row">
      <form
        className="add-registry-form"
        aria-label="Add registry"
        onSubmit={form.onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') form.onCancel()
        }}
      >
        {form.source === 'folder' ? (
          <span className="add-folder mono" title={form.url}>
            {form.url}
          </span>
        ) : (
          <input
            className="field-input"
            type="text"
            aria-label="Repository URL"
            value={form.url}
            onChange={(e) => form.onUrlChange(e.target.value)}
            placeholder="https://github.com/org/repo"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        )}
        <button type="button" className="secondary" onClick={form.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={form.busy || !form.url.trim()}>
          {form.busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {form.source === 'git' ? <BranchField form={form} /> : null}
      {form.error ? (
        <p className="settings-error" role="alert">
          {form.error}
        </p>
      ) : null}
    </li>
  )
}
