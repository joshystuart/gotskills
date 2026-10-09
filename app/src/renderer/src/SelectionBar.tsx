import type { JSX } from 'react'

interface SelectionBarProps {
  count: number
  onClear: () => void
}

/**
 * Shown above the Catalogue rows in place of "Update all" while two or more
 * skills are selected.
 */
export function SelectionBar({ count, onClear }: SelectionBarProps): JSX.Element {
  return (
    <div className="update-all selection-bar" role="region" aria-label="Selection">
      <span className="update-all-count" role="status" aria-live="polite">
        {count} selected
      </span>
      <button type="button" className="secondary" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}
