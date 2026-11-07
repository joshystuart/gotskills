import type { JSX } from 'react'
import type { InstallTargetId, InstallTargetStatus, SkillSummary } from '../../shared/ipc'
import { replaceOutcome, targetLabel } from './cataloguePresentation'

/** One skill's collided targets to replace, each with what happens to what is there. */
export interface ReplaceEntry {
  skillId: string
  name: string
  targets: { id: InstallTargetId; label: string; outcome: string }[]
}

export function replaceEntry(
  skill: SkillSummary,
  replaceTargets: InstallTargetId[],
  targets: InstallTargetStatus[]
): ReplaceEntry {
  return {
    skillId: skill.id,
    name: skill.name,
    targets: replaceTargets.map((id) => ({
      id,
      label: targetLabel(targets, id),
      outcome: replaceOutcome(skill, id),
    })),
  }
}

function targetItems(entry: ReplaceEntry): JSX.Element[] {
  return entry.targets.map((target) => (
    <li key={target.id}>
      {target.label}: {target.outcome}
    </li>
  ))
}

/**
 * The body of the replace confirmation: each target that will be replaced and
 * what happens to the skill already there, grouped by skill when there are several.
 */
export function ReplaceList({ entries }: { entries: ReplaceEntry[] }): JSX.Element {
  if (entries.length === 1) {
    return (
      <>
        <p>Replace the existing “{entries[0].name}” with this registry’s copy?</p>
        <ul className="replace-list" aria-label="Targets to replace">
          {targetItems(entries[0])}
        </ul>
      </>
    )
  }
  return (
    <>
      <p>Replace the existing copies of these skills with each registry’s copy?</p>
      <ul className="replace-list" aria-label="Skills to replace">
        {entries.map((entry) => (
          <li key={entry.skillId}>
            {entry.name}
            <ul aria-label={`Targets to replace for ${entry.name}`}>{targetItems(entry)}</ul>
          </li>
        ))}
      </ul>
    </>
  )
}
