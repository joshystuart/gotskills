import type { JSX } from 'react'
import type { InstallTargetStatus, RegistryRecord, SkillSummary } from '../../shared/ipc'
import { registryDotColour, rowAttention, targetsWithSkill } from './cataloguePresentation'

interface CatalogueListProps {
  skills: SkillSummary[]
  targets: InstallTargetStatus[]
  selectedId: string | null
  emptyMessage: string
  registriesById: Map<string, RegistryRecord>
  onSelect: (skillId: string) => void
}

function labelList(targets: InstallTargetStatus[]): string {
  return targets.map((target) => target.label).join(', ')
}

function InstalledCell({
  skill,
  targets,
}: {
  skill: SkillSummary
  targets: InstallTargetStatus[]
}): JSX.Element {
  const installed = targetsWithSkill(skill, targets)
  if (installed.length === 0) {
    return (
      <span className="installed-cell">
        <span className="sr-only">Not installed</span>
        <span aria-hidden="true">—</span>
      </span>
    )
  }
  const attention = rowAttention(skill, targets)
  const spoken = [
    `Installed in ${labelList(installed)}`,
    ...(attention ? [`${attention.label.text} in ${labelList(attention.targets)}`] : []),
  ].join('. ')
  return (
    <span className="installed-cell">
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true">{installed.length}</span>
      {attention ? (
        <span aria-hidden="true" className={`installed-attention agent-${attention.label.tone}`}>
          <span className="glyph">{attention.label.glyph}</span>
          <span>{attention.label.cellText}</span>
        </span>
      ) : null}
      <span role="tooltip" aria-hidden="true" className="installed-targets">
        {labelList(installed)}
      </span>
    </span>
  )
}

export function CatalogueList({
  skills,
  targets,
  selectedId,
  emptyMessage,
  registriesById,
  onSelect,
}: CatalogueListProps): JSX.Element {
  return (
    <>
      <div className="catalogue-head" aria-hidden="true">
        <span>Skill</span>
        <span>Installed</span>
      </div>
      <div className="pane-body catalogue-list" role="list">
        {skills.length === 0 ? (
          <p className="empty">{emptyMessage}</p>
        ) : (
          skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              role="listitem"
              className={`skill-row${skill.id === selectedId ? ' selected' : ''}${skill.softDeleted ? ' soft-deleted' : ''}`}
              onClick={() => onSelect(skill.id)}
            >
              <span className="skill-cell">
                <span className="skill-row-main">
                  <span
                    className="dot"
                    role="img"
                    aria-label={skill.registryLabel}
                    title={skill.registryLabel}
                    style={{
                      background: registryDotColour(
                        registriesById.get(skill.registryId) ?? {
                          id: skill.registryId,
                          enabled: true,
                          colour: null,
                        }
                      ),
                    }}
                  />
                  <span className="skill-name">{skill.name}</span>
                  {skill.conflict ? (
                    <>
                      <span className="skill-conflict" title="Skill Conflict">
                        Conflict
                      </span>
                      <span className="skill-registry">{skill.registryLabel}</span>
                    </>
                  ) : null}
                </span>
                <span className="skill-desc">{skill.description}</span>
              </span>
              <InstalledCell skill={skill} targets={targets} />
            </button>
          ))
        )}
      </div>
    </>
  )
}
