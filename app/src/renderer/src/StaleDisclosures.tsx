import type { JSX } from 'react'
import { formatLastSynced, type StaleRegistryDisclosure } from './cataloguePresentation'

interface StaleDisclosuresProps {
  disclosures: StaleRegistryDisclosure[]
  acknowledgeStale: boolean
  onAcknowledgeStale: (on: boolean) => void
}

/** One line per stale Registry holding skills back, with the run-level acknowledgement. */
export function StaleDisclosures({
  disclosures,
  acknowledgeStale,
  onAcknowledgeStale,
}: StaleDisclosuresProps): JSX.Element | null {
  if (disclosures.length === 0) return null
  return (
    <div className="update-all-stale">
      {disclosures.map((d) => (
        <p key={d.registryId} className="update-all-stale-line">
          {d.label} — {formatLastSynced(d.lastSyncedAt)} —{' '}
          {d.affected === 1 ? '1 skill held back' : `${d.affected} skills held back`}
        </p>
      ))}
      <label className="update-all-stale-ack">
        <input
          type="checkbox"
          checked={acknowledgeStale}
          onChange={(e) => onAcknowledgeStale(e.target.checked)}
        />
        Include held-back skills from stale registries
      </label>
    </div>
  )
}

interface HeldBackListProps {
  items: { skillId: string; name: string; registryId: string }[]
  disclosures: StaleRegistryDisclosure[]
}

/** The skills a run held back, each naming its stale Registry and last sync. */
export function HeldBackList({ items, disclosures }: HeldBackListProps): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul className="update-all-held-back">
      {items.map((item) => {
        const disclosure = disclosures.find((d) => d.registryId === item.registryId)
        const detail = disclosure
          ? `${disclosure.label}, ${formatLastSynced(disclosure.lastSyncedAt)}`
          : item.registryId
        return (
          <li key={item.skillId}>
            {item.name}: held back — stale Registry snapshot ({detail})
          </li>
        )
      })}
    </ul>
  )
}
