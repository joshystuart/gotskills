export type InstallMethod = 'symlink' | 'copy'

export type InstallTargetId = string

export type SyncPhase = 'syncing' | 'synced' | 'failed'

/** Aggregate catalogue refresh can also be partial when some registries fail. */
export type CatalogueSyncPhase = SyncPhase | 'partial'

/**
 * Why a Registry sync failed.
 * `access-required` covers GitHub's ambiguous not-found / auth failures —
 * the app cannot distinguish them and must not claim it can.
 */
export type SyncFailureReason = 'offline' | 'empty' | 'access-required'

export interface RegistrySyncStatus {
  registryId: string
  phase: SyncPhase
  /** ISO-8601 of the last successful sync for this Registry, or null if never. */
  lastSyncedAt: string | null
  /** Present only when phase is 'failed'. */
  reason?: SyncFailureReason
  /** origin/<branch> HEAD SHA at last successful sync. */
  revision?: string
  /** Count of valid, visible skills after the last successful sync. */
  visibleSkillCount?: number
  /** True when the last successful Registry Snapshot is being shown after a later failure. */
  stale?: boolean
}

export interface SyncStatus {
  phase: CatalogueSyncPhase
  /** ISO-8601 of the most recent successful Registry sync across enabled Registries. */
  lastSyncedAt: string | null
  /** Present when phase is 'failed' and every enabled Registry failed the same way. */
  reason?: SyncFailureReason
  /** Present for single-registry convenience / last global revision when useful. */
  revision?: string
  visibleSkillCount?: number
  /** Per-Registry outcomes for the combined Catalogue. */
  registries: RegistrySyncStatus[]
}

export interface SyncAllResult {
  registries: RegistrySyncStatus[]
}

export type ReconcileState =
  | 'installed'
  | 'update-available'
  | 'needs-repair'
  | 'not-installed'
  | 'external'
  | 'other-registry'
  | 'removed-from-registry'
  | 'orphaned'

export interface AutoUpdateResult {
  registryId: string
  registryLabel: string
  updated: { folderName: string; name: string; targets: InstallTargetId[] }[]
  failed: { folderName: string; name: string; reason: string }[]
}

export interface PerTargetState {
  target: InstallTargetId
  state: ReconcileState
  /** Short provenance SHA of the installed snapshot, when installed. */
  installedVersion?: string
}

export interface SkillSummary {
  /** Stable Skill identity: Registry id + folder name. */
  registryId: string
  folderName: string
  /**
   * Composite key `${registryId}/${folderName}` for list keys and IPC convenience.
   * Folder name alone is not unique across Registries.
   */
  id: string
  name: string
  description: string
  /** Display label for the supplying Registry (e.g. owner/repo or host path). */
  registryLabel: string
  /** True when another enabled Registry also supplies this folder name. */
  conflict: boolean
  /** True when this entry comes from a stale Registry Snapshot. */
  stale: boolean
  /**
   * True when the Skill is installed but its Registry was removed
   * (Orphaned Installation) — available-catalogue contribution is hidden.
   */
  orphaned: boolean
  /** Short provenance SHA of the folder's last-touching commit at HEAD. */
  latestVersion?: string
  /** ISO-8601 date of the folder's last-touching commit at HEAD. */
  updatedAt?: string
  softDeleted: boolean
  perTarget: PerTargetState[]
}

export interface CatalogueSnapshot {
  skills: SkillSummary[]
  syncStatus: SyncStatus
}

export interface RegistryRecord {
  id: string
  url: string
  branch: string
  enabled: boolean
  autoUpdate: boolean
  /** GitHub owner when the URL is a GitHub repository; otherwise null. */
  githubOwner: string | null
  /** GitHub repo name when the URL is a GitHub repository; otherwise null. */
  githubRepo: string | null
  /** Chosen Registry Colour as lowercase `#rrggbb`; null means the automatic colour. */
  colour: string | null
  /** Friendly Registry Name; null means the automatic name. */
  name: string | null
  syncStatus: RegistrySyncStatus
}

export interface AddRegistryRequest {
  url: string
  /** Required when default-branch detection fails or the remote is inaccessible. */
  branch?: string
  enabled?: boolean
}

export interface UpdateRegistryRequest {
  id: string
  url?: string
  branch?: string
  enabled?: boolean
  autoUpdate?: boolean
  /** A `#rrggbb` hex colour; stored lowercase. */
  colour?: string
  /** Friendly Registry Name, trimmed; an empty string clears it. */
  name?: string
}

/** Longest Registry Name allowed, after trimming. */
export const MAX_REGISTRY_NAME_LENGTH = 40

/** @deprecated Prefer RegistryRecord; retained only while callers migrate. */
export interface RegistryConfig {
  url: string
  branch: string
}

export interface InstallTargetAgent {
  id: string
  displayName: string
  detected: boolean
}

export interface InstallTargetStatus {
  id: InstallTargetId
  label: string
  shared: boolean
  visible: boolean
  agents: InstallTargetAgent[]
}

export interface SupportedAgent {
  id: string
  displayName: string
  target: InstallTargetId
  detected: boolean
}

export interface TargetDetection {
  targets: InstallTargetStatus[]
  agents: SupportedAgent[]
}

export interface InstallRequest {
  registryId: string
  /** Folder name within the Registry (skills/<folderName>/). */
  folderName: string
  targets: InstallTargetId[]
  /** HEAD SHA the user acted on; pins the operation against a mid-install advance. */
  mirrorRevision: string
  /** Required to install/update from a stale Registry Snapshot. */
  acknowledgeStale?: boolean
}

export interface TargetResult {
  target: InstallTargetId
  outcome: 'installed' | 'failed' | 'skipped'
  method: InstallMethod
  paths: string[]
  /** Redacted; never contains credentials or raw argv. */
  error?: string
}

export interface InstallResult {
  registryId: string
  folderName: string
  /** Composite `${registryId}/${folderName}`. */
  skillId: string
  mirrorRevision: string
  contentHash: string
  provenanceSha: string
  cliVersion: string
  perTarget: TargetResult[]
  installedAt: string
}

/** Persisted product truth for a skill × target install. */
export interface InstallRecord {
  registryId: string
  folderName: string
  target: InstallTargetId
  contentHash: string
  provenanceSha: string
  method: InstallMethod
  paths: string[]
  cliVersion: string
  installedAt: string
}

export interface UninstallRequest {
  registryId: string
  folderName: string
  targets: InstallTargetId[]
}

export interface UninstallResult {
  registryId: string
  folderName: string
  skillId: string
  perTarget: Pick<TargetResult, 'target' | 'outcome' | 'paths' | 'error'>[]
}

export interface DiskProbe {
  path: string
  exists: boolean
  isSymlink: boolean
  resolves: boolean
  contentHash?: string
}

export interface ReconcileEntry {
  registryId: string
  folderName: string
  skillId: string
  target: InstallTargetId
  state: ReconcileState
  installedHash?: string
  mirrorHash?: string
  disk: DiskProbe[]
  lockAgrees: boolean
}

export interface ReconcileReport {
  scannedAt: string
  entries: ReconcileEntry[]
}

export class InstallationCollisionError extends Error {
  readonly code = 'installation-collision' as const
  constructor(
    message: string,
    readonly occupant: 'managed' | 'external',
    readonly folderName: string,
    readonly target: InstallTargetId
  ) {
    super(message)
    this.name = 'InstallationCollisionError'
  }
}

export interface SkillFileEntry {
  /** POSIX-relative path from the skill directory root. */
  path: string
  sizeBytes: number
  viewable: boolean
}

export interface SkillFileList {
  files: SkillFileEntry[]
  /** Present when the skill directory cannot be read (missing mirror path). */
  unavailable?: 'missing'
}

export interface SkillFileContent {
  path: string
  sizeBytes: number
  kind: 'text' | 'binary' | 'missing'
  /** Present for kind 'text'. */
  content?: string
  /** True when the size cap cut the content. */
  truncated?: boolean
}

export interface SkillFileRequest {
  registryId: string
  folderName: string
}

export interface SkillFileReadRequest extends SkillFileRequest {
  path: string
}

/**
 * The single renderer <-> main seam. The renderer never touches git, fs or
 * node: it only calls these methods and subscribes to these events. A Skill's
 * identity is registryId + folderName (ADR 0001).
 */
export interface AppApi {
  detectTargets(): Promise<TargetDetection>
  install(req: InstallRequest): Promise<InstallResult>
  reconcile(req?: { registryId?: string; folderName?: string }): Promise<ReconcileReport>
  repair(req: InstallRequest): Promise<InstallResult>
  uninstall(req: UninstallRequest): Promise<UninstallResult>
  getCatalogue(): Promise<CatalogueSnapshot>
  /** Refresh every enabled Registry; partial success is reported per Registry. */
  refresh(): Promise<SyncAllResult>
  getSyncStatus(): Promise<SyncStatus>
  listRegistries(): Promise<RegistryRecord[]>
  addRegistry(req: AddRegistryRequest): Promise<RegistryRecord>
  updateRegistry(req: UpdateRegistryRequest): Promise<RegistryRecord>
  removeRegistry(id: string): Promise<void>
  syncRegistry(id: string): Promise<RegistrySyncStatus>
  listSkillFiles(req: SkillFileRequest): Promise<SkillFileList>
  readSkillFile(req: SkillFileReadRequest): Promise<SkillFileContent>
}

export type AppUpdateState =
  | {
      kind: 'idle'
      currentVersion: string
      lastCheck?: { at: string; result: 'up-to-date' | 'error'; message?: string }
    }
  | { kind: 'checking'; currentVersion: string }
  | { kind: 'available'; currentVersion: string; version: string }
  | { kind: 'downloading'; currentVersion: string; version: string; percent: number }
  | { kind: 'ready'; currentVersion: string; version: string; waiting: boolean }
  | { kind: 'download-failed'; currentVersion: string; version: string; message: string }

export interface AppUpdateApi {
  getAppUpdateState(): Promise<AppUpdateState>
  checkAppUpdate(): Promise<void>
  getAutoDownloadAppUpdates(): Promise<boolean>
  setAutoDownloadAppUpdates(enabled: boolean): Promise<void>
  downloadAppUpdate(): Promise<void>
  restartForAppUpdate(): Promise<void>
}

/** An action from the sidebar registry menu that the renderer runs itself. */
export type RegistryMenuAction =
  'sync' | 'toggle-enabled' | 'toggle-auto-update' | 'show-settings' | 'remove'

export interface RegistryMenuRequest {
  registryId: string
  /** True while registry work is in progress; disables the changing items. */
  busy: boolean
  /** Where to open the menu, in window coordinates; omitted to open at the pointer. */
  position?: { x: number; y: number }
}

export interface RegistryMenuApi {
  /** Show the native registry menu; resolves to the renderer action chosen, or null. */
  showRegistryMenu(req: RegistryMenuRequest): Promise<RegistryMenuAction | null>
}

export type Unsubscribe = () => void

/** What the renderer actually receives on window.api: requests + event subscriptions. */
export interface RendererApi extends AppApi, AppUpdateApi, RegistryMenuApi {
  onAppUpdateState(cb: (state: AppUpdateState) => void): Unsubscribe
  onSyncStatus(cb: (status: SyncStatus) => void): Unsubscribe
  onCatalogueUpdated(cb: () => void): Unsubscribe
  onAutoUpdateResult(cb: (result: AutoUpdateResult) => void): Unsubscribe
}

export const IpcRequest = {
  getAppUpdateState: 'appUpdate:getState',
  checkAppUpdate: 'appUpdate:check',
  getAutoDownloadAppUpdates: 'appUpdate:getAutoDownload',
  setAutoDownloadAppUpdates: 'appUpdate:setAutoDownload',
  downloadAppUpdate: 'appUpdate:download',
  restartForAppUpdate: 'appUpdate:restart',
  detectTargets: 'api:detectTargets',
  install: 'api:install',
  reconcile: 'api:reconcile',
  repair: 'api:repair',
  uninstall: 'api:uninstall',
  getCatalogue: 'api:getCatalogue',
  refresh: 'api:refresh',
  getSyncStatus: 'api:getSyncStatus',
  listRegistries: 'api:listRegistries',
  addRegistry: 'api:addRegistry',
  updateRegistry: 'api:updateRegistry',
  removeRegistry: 'api:removeRegistry',
  syncRegistry: 'api:syncRegistry',
  listSkillFiles: 'api:listSkillFiles',
  readSkillFile: 'api:readSkillFile',
  showRegistryMenu: 'registryMenu:show',
} as const

export const IpcEvent = {
  appUpdateState: 'appUpdate:state',
  syncStatus: 'sync:status',
  catalogueUpdated: 'catalogue:updated',
  autoUpdateResult: 'catalogue:autoUpdateResult',
} as const

/** Build the composite Skill id used in catalogue rows and install results. */
export function skillId(registryId: string, folderName: string): string {
  return `${registryId}/${folderName}`
}
