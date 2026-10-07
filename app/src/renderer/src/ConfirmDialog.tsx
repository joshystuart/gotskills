import { useEffect, useId, type JSX, type ReactNode } from 'react'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  confirmDisabled: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const id = useId()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={`${id}-title`} className="modal-title">
          {title}
        </h2>
        <p id={`${id}-desc`} className="modal-body">
          {children}
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
