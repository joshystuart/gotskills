import type {
  InstallTargetId,
  InstallTargetStatus,
  ReconcileState,
  RegistrySyncStatus,
  SkillSummary,
  SyncStatus,
} from '../../shared/ipc'

export type CatalogueView = 'all' | 'installed' | 'updates'
export type RegistryFilter = 'all' | string

const VIEW_LABELS: Record<CatalogueView, string> = {
  all: 'Catalogue',
  installed: 'Installed',
  updates: 'Updates',
}

export const CATALOGUE_VIEWS: CatalogueView[] = ['all', 'installed', 'updates']

export function viewLabel(view: CatalogueView): string {
  return VIEW_LABELS[view]
}

/** Canonical copy for GitHub's ambiguous not-found / no-access failures. */
export const ACCESS_REQUIRED_TITLE = 'Repository not found or access required'

/** Setup guidance shown alongside an access-required failure (no auth claim). */
export const ACCESS_REQUIRED_GUIDANCE =
  'Verify you can clone it over HTTPS using system Git outside the app, then sync again.'

export function formatLastSynced(iso: string | null): string {
  if (!iso) return 'not yet synced'
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return 'last synced just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `last synced ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `last synced ${hours}h ago`
  return `last synced ${Math.round(hours / 24)}d ago`
}

export function syncLabel(status: SyncStatus): { glyph: string; text: string } {
  switch (status.phase) {
    case 'syncing':
      return { glyph: '↻', text: 'Syncing…' }
    case 'partial':
      return { glyph: '!', text: 'Partial sync' }
    case 'failed':
      return { glyph: '×', text: 'Sync failed' }
    case 'synced':
    default:
      return { glyph: '✓', text: 'Synced' }
  }
}

export function bannerMessage(status: SyncStatus): string | null {
  if (status.phase === 'partial') {
    return 'Some registries could not be synced — showing the latest available skills. Open Settings to review each registry.'
  }
  if (status.phase !== 'failed' || !status.reason) return null
  switch (status.reason) {
    case 'offline':
      return `Couldn't reach the registry — showing cached catalogue (${formatLastSynced(status.lastSyncedAt)}).`
    case 'empty':
      return 'No skills found — check the repo URL in Settings.'
    case 'access-required':
      return `${ACCESS_REQUIRED_TITLE}. ${ACCESS_REQUIRED_GUIDANCE}`
    default:
      return null
  }
}

/** Per-Registry status text for the Settings registry list. */
export function registryStatusLabel(status: RegistrySyncStatus): { glyph: string; text: string } {
  switch (status.phase) {
    case 'syncing':
      return { glyph: '↻', text: 'Syncing…' }
    case 'failed': {
      const base =
        status.reason === 'access-required'
          ? ACCESS_REQUIRED_TITLE
          : status.reason === 'empty'
            ? 'No skills found'
            : 'Offline'
      return { glyph: '×', text: status.stale ? `${base} — showing last snapshot` : base }
    }
    case 'synced':
    default:
      return status.lastSyncedAt
        ? { glyph: '✓', text: 'Synced' }
        : { glyph: '·', text: 'Not yet synced' }
  }
}

/** Warning shown on a stale skill (revision + age) before install/update. */
export function staleSkillNotice(skill: SkillSummary): string | null {
  if (!skill.stale) return null
  const age = formatUpdatedAt(skill.updatedAt)
  const detail = [
    skill.latestVersion ? `revision ${skill.latestVersion}` : null,
    age ? age.replace(/^Updated /, 'updated ') : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
  return detail
    ? `Stale snapshot after a failed sync — ${detail}. Acknowledge to install or update.`
    : 'Stale snapshot after a failed sync. Acknowledge to install or update.'
}

export function formatUpdatedAt(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `Updated ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)}`
}

/**
 * GitHub repository URLs have an unambiguous account path segment. Other
 * registry formats are intentionally omitted rather than presented as owners.
 */
export function registryOwnerLabel(registryUrl: string | undefined): string | null {
  if (!registryUrl) return null

  const scpMatch = /^git@github\.com:([^/]+)\/[^/]+?\/?(?:\.git)?$/i.exec(registryUrl.trim())
  if (scpMatch) return scpMatch[1]

  try {
    const url = new URL(registryUrl)
    if (url.hostname.toLocaleLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    return parts.length === 2 ? parts[0] : null
  } catch {
    return null
  }
}

/**
 * Registry Name for a configured Registry record: the friendly name when set,
 * otherwise the automatic name. Mirrors the main-process `registryLabel` so
 * provenance reads identically on both sides of the seam.
 */
export function registryRecordLabel(registry: {
  githubOwner: string | null
  githubRepo: string | null
  url: string
  name: string | null
}): string {
  return registry.name ?? automaticRegistryRecordLabel(registry)
}

/** Automatic name for a Registry record: `owner/repo` for GitHub, else host + path, else the raw URL. */
export function automaticRegistryRecordLabel(registry: {
  githubOwner: string | null
  githubRepo: string | null
  url: string
}): string {
  if (registry.githubOwner && registry.githubRepo) {
    return `${registry.githubOwner}/${registry.githubRepo}`
  }
  try {
    const url = new URL(registry.url)
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return registry.url
  }
}

export const REGISTRY_PALETTE = [
  '#60a5fa',
  '#f472b6',
  '#34d399',
  '#fb923c',
  '#a78bfa',
  '#22d3ee',
] as const

const DISABLED_REGISTRY_COLOUR = '#5b5b64'

export function registryColour(registryId: string): string {
  let hash = 0
  for (const char of registryId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return REGISTRY_PALETTE[hash % REGISTRY_PALETTE.length]
}

/** The Registry Colour a dot shows: grey when disabled, else the chosen colour, else the palette's. */
export function registryDotColour(registry: {
  id: string
  enabled: boolean
  colour: string | null
}): string {
  if (!registry.enabled) return DISABLED_REGISTRY_COLOUR
  return registry.colour ?? registryColour(registry.id)
}

export function targetLabel(targets: InstallTargetStatus[], target: InstallTargetId): string {
  return targets.find((candidate) => candidate.id === target)?.label ?? target
}

export interface StateLabel {
  glyph: string
  text: string
}

const STATE_LABELS: Record<ReconcileState, StateLabel> = {
  installed: { glyph: '✓', text: 'Installed' },
  'update-available': { glyph: '↑', text: 'Update ready' },
  'needs-repair': { glyph: '!', text: 'Needs repair' },
  'removed-from-registry': { glyph: '×', text: 'Removed' },
  external: { glyph: '·', text: 'External' },
  orphaned: { glyph: '⊘', text: 'Orphaned' },
  'other-registry': { glyph: '·', text: 'Held by another registry' },
  'not-installed': { glyph: '·', text: 'Not installed' },
}

export function targetState(skill: SkillSummary, target: InstallTargetId): ReconcileState {
  return skill.perTarget.find((p) => p.target === target)?.state ?? 'not-installed'
}

export function targetStateLabel(skill: SkillSummary, target: InstallTargetId): StateLabel {
  return STATE_LABELS[targetState(skill, target)]
}

export interface AttentionLabel {
  tone: 'warn' | 'bad' | 'quiet'
  glyph: string
  text: string
  cellText: string
}

const ATTENTION_LABELS: [ReconcileState, AttentionLabel][] = [
  ['needs-repair', { tone: 'bad', glyph: '!', text: 'Needs repair', cellText: 'Repair' }],
  ['removed-from-registry', { tone: 'bad', glyph: '×', text: 'Removed', cellText: 'Removed' }],
  ['orphaned', { tone: 'quiet', glyph: '⊘', text: 'Orphaned', cellText: 'Orphaned' }],
  ['update-available', { tone: 'warn', glyph: '↑', text: 'Update ready', cellText: 'Update' }],
]

export interface RowAttention {
  label: AttentionLabel
  targets: InstallTargetStatus[]
}

const INSTALLED_LIKE: ReconcileState[] = [
  'installed',
  'update-available',
  'needs-repair',
  'removed-from-registry',
]

function holdsState(skill: SkillSummary, target: InstallTargetId, state: ReconcileState): boolean {
  const reported = targetState(skill, target)
  if (state === 'orphaned') return skill.orphaned && INSTALLED_LIKE.includes(reported)
  return reported === state
}

export function rowAttention(
  skill: SkillSummary,
  targets: InstallTargetStatus[]
): RowAttention | null {
  for (const [state, label] of ATTENTION_LABELS) {
    const held = targets.filter((target) => holdsState(skill, target.id, state))
    if (held.length > 0) return { label, targets: held }
  }
  return null
}

export function isInstalledLike(skill: SkillSummary): boolean {
  return skill.perTarget.some((p) => INSTALLED_LIKE.includes(p.state))
}

export function targetsWithSkill(
  skill: SkillSummary,
  targets: InstallTargetStatus[]
): InstallTargetStatus[] {
  return targets.filter((target) => INSTALLED_LIKE.includes(targetState(skill, target.id)))
}

export function hasUpdate(skill: SkillSummary): boolean {
  return skill.perTarget.some((p) => p.state === 'update-available')
}

export function skillsInView(skills: SkillSummary[], view: CatalogueView): SkillSummary[] {
  switch (view) {
    case 'installed':
      return skills.filter(isInstalledLike)
    case 'updates':
      return skills.filter(hasUpdate)
    case 'all':
    default:
      return skills
  }
}

export function filterByRegistry(
  skills: SkillSummary[],
  registryFilter: RegistryFilter
): SkillSummary[] {
  if (registryFilter === 'all') return skills
  return skills.filter((skill) => skill.registryId === registryFilter)
}

export function searchSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return skills

  return skills.filter((skill) =>
    [skill.id, skill.name, skill.description].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
}

/** One Skill's pending bulk-update work: only the targets currently behind. */
export interface UpdateItem {
  registryId: string
  folderName: string
  /** Composite `${registryId}/${folderName}`, matching `SkillSummary.id`. */
  skillId: string
  /** Display name, for run progress and failure reporting. */
  name: string
  /** Only the targets reporting `update-available`; a current target is untouched. */
  targets: InstallTargetId[]
  /**
   * True when the supplying Registry Snapshot is stale: the item is held back
   * unless the run-level stale acknowledgement is on.
   */
  staleGated: boolean
}

/** Per-Registry disclosure for the stale-gated case, shown before a run. */
export interface StaleRegistryDisclosure {
  registryId: string
  /** Display label for the Registry (owner/repo or host path). */
  label: string
  /** ISO-8601 of the Registry's last successful sync, or null if never. */
  lastSyncedAt: string | null
  /** How many of this Registry's behind Skills are held back. */
  affected: number
}

/** The bulk-update work set, partitioned by stale-Registry gating. */
export interface UpdateWorkSet {
  /** Every behind Skill, ready and stale-gated, in Catalogue order. */
  all: UpdateItem[]
  /** Dispatchable without any acknowledgement. */
  ready: UpdateItem[]
  /** Held back unless the run-level stale acknowledgement is on. */
  staleGated: UpdateItem[]
  /** One entry per stale Registry contributing Skills, in first-seen order. */
  disclosures: StaleRegistryDisclosure[]
}

/**
 * Every Skill with at least one target reporting `update-available`, across
 * all enabled Registries — independent of search text, the Registry filter,
 * and the active view. Reconciliation never reports `update-available`
 * for a Skill supplied by a Disabled or removed Registry, or for an Orphaned
 * Installation (see `deriveState` in `main/installer/reconcile.ts`), so those
 * Skills are excluded here without special-casing.
 */
export function deriveUpdateItems(skills: SkillSummary[]): UpdateItem[] {
  const items: UpdateItem[] = []
  for (const skill of skills) {
    const targets = skill.perTarget
      .filter((p) => p.state === 'update-available')
      .map((p) => p.target)
    if (targets.length === 0) continue
    items.push({
      registryId: skill.registryId,
      folderName: skill.folderName,
      skillId: skill.id,
      name: skill.name,
      targets,
      staleGated: skill.stale,
    })
  }
  return items
}

/**
 * The full bulk-update work set: `deriveUpdateItems` partitioned into ready
 * and stale-gated groups, plus the per-Registry disclosure data — label,
 * last-synced time, affected count — for the stale case. A Registry only
 * appears in `disclosures` when it actually contributes behind Skills.
 */
export function deriveUpdateWork(skills: SkillSummary[], status: SyncStatus | null): UpdateWorkSet {
  const all = deriveUpdateItems(skills)
  const ready = all.filter((item) => !item.staleGated)
  const staleGated = all.filter((item) => item.staleGated)
  return { all, ready, staleGated, disclosures: staleDisclosures(staleGated, skills, status) }
}

/**
 * One disclosure per stale Registry among `gated`, in first-seen order, with
 * its label, last-synced time and how many of `gated` it supplies.
 */
export function staleDisclosures(
  gated: readonly { registryId: string }[],
  skills: SkillSummary[],
  status: SyncStatus | null
): StaleRegistryDisclosure[] {
  const disclosures: StaleRegistryDisclosure[] = []
  for (const item of gated) {
    const existing = disclosures.find((d) => d.registryId === item.registryId)
    if (existing) {
      existing.affected += 1
      continue
    }
    disclosures.push({
      registryId: item.registryId,
      label: skills.find((s) => s.registryId === item.registryId)?.registryLabel ?? item.registryId,
      lastSyncedAt:
        status?.registries.find((r) => r.registryId === item.registryId)?.lastSyncedAt ?? null,
      affected: 1,
    })
  }
  return disclosures
}
