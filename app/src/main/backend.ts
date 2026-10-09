import type { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  skillId as makeSkillId,
  type AddRegistryRequest,
  type AutoUpdateResult,
  type AppApi,
  type CatalogueSnapshot,
  type InstallRequest,
  type InstallResult,
  type InstallTargetId,
  type ReconcileReport,
  type RegistryRecord,
  type RegistrySyncStatus,
  type SkillFileContent,
  type SkillFileList,
  type SkillFileReadRequest,
  type SkillFileRequest,
  type SyncAllResult,
  type SyncStatus,
  type TargetResult,
  type InstallTargetStatus,
  type TargetDetection,
  type UninstallRequest,
  type UninstallResult,
  type UpdateRegistryRequest,
  MAX_REGISTRY_NAME_LENGTH,
} from '../shared/ipc'
import { canonicalizeRegistryUrl } from '../shared/registryUrl'
import { DEFAULT_REGISTRY } from './config'
import { getAutoDownloadAppUpdates, setAutoDownloadAppUpdates } from './appSettings'
import { openDatabase } from './db/open'
import { aggregateSyncStatus, readCatalogue, registrySyncStatusFromMarker } from './catalogue'
import { detectDefaultBranch, isGitAvailable } from './mirror/git'
import { git } from './mirror/git-exec'
import { classifyGitError, redactGitError } from './mirror/gitErrors'
import {
  findByCanonicalKey,
  getMarker,
  getRegistry,
  hardDeleteRegistry,
  insertRegistry,
  listRegistries,
  recordMarkerFailure,
  registryLabel,
  softRemoveRegistry,
  updateRegistry,
  type StoredRegistry,
} from './registries'
import { syncRegistry, type SyncRegistryFn } from './sync'
import type { AgentEnvironment } from './mirror/discovery/agents'
import { createSkillsCliRunner, type RunSkillsCli } from './installer/cli'
import { convertSymlinkInstalls } from './installer/convert'
import {
  detectInstallTargets,
  supportedAgents,
  targetInstallPath,
  telemetryTargets,
} from './installer/targets'
import { redactError } from './installer/errors'
import { installSkill, REVISION_REFUSED_MESSAGE } from './installer/install'
import { createAsyncMutex } from './installer/mutex'
import { reconcile } from './installer/reconcile'
import { readInstallRecords } from './installer/records'
import { uninstallSkill } from './installer/uninstall'
import { listSkillFiles, readSkillFile } from './skillFiles'
import {
  createTelemetryLog,
  executeInstallLifecycle,
  readSkillTelemetryDimensions,
  type InstallLifecycleRequest,
  type TelemetryAction,
  type TelemetryLog,
} from './telemetry'

/** App version stamped on every telemetry envelope (matches package.json). */
export const APP_VERSION = '0.0.1'

/** Bounded concurrent syncs across Registries during a global refresh. */
export const MAX_CONCURRENT_SYNCS = 3

export interface BackendPaths {
  userData: string
}

export interface BackendOptions {
  paths: BackendPaths
  onSyncStatus?: (status: SyncStatus) => void
  onCatalogueUpdated?: () => void
  onAutoUpdateResult?: (result: AutoUpdateResult) => void
  onBusyChange?: (busy: boolean) => void
  /** Periodic sync interval; default 30 minutes. Set 0 to disable. */
  syncIntervalMs?: number
  homeDir?: string
  env?: AgentEnvironment['env']
  exists?: AgentEnvironment['exists']
  runSkillsCli?: RunSkillsCli
  appVersion?: string
  /**
   * Test-only seam to drive the sync failure path (e.g. a simulated
   * auth-ambiguous git error) without live GitHub. Defaults to the real
   * {@link syncRegistry}; the backend still redacts and classifies whatever it
   * throws, so `access-required` is recorded end-to-end.
   */
  syncRegistryImpl?: SyncRegistryFn
}

export interface Backend extends AppApi {
  getAutoDownloadAppUpdates(): boolean
  setAutoDownloadAppUpdates(enabled: boolean): void
  isBusy(): boolean
  /** Refresh all enabled Registries; returns the aggregate status. */
  syncNow(): Promise<SyncStatus>
  close(): void
  telemetry: TelemetryLog
}

const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000

/** Run `fn` over `items` with a bounded number of concurrent executions. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export function createBackend(options: BackendOptions): Backend {
  const { paths, onSyncStatus, onCatalogueUpdated } = options
  const syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  const homeDir = options.homeDir ?? homedir()
  const environment: AgentEnvironment = {
    home: homeDir,
    env: options.env ?? process.env,
    exists: options.exists ?? existsSync,
  }
  const runSkillsCli = options.runSkillsCli ?? createSkillsCliRunner()
  const appVersion = options.appVersion ?? APP_VERSION
  const runSyncRegistry = options.syncRegistryImpl ?? syncRegistry

  const dbPath = join(paths.userData, 'cache.sqlite')
  const mirrorsRoot = join(paths.userData, 'mirrors')
  const db: DatabaseSync = openDatabase(dbPath)
  convertSymlinkInstalls(db, homeDir)
  const telemetry = createTelemetryLog({
    db,
    userData: paths.userData,
    appVersion,
    knownTargets: () =>
      telemetryTargets(
        environment,
        readInstallRecords(db).map((record) => record.target)
      ),
  })

  const locks = new Map<string, ReturnType<typeof createAsyncMutex>>()
  const inFlightSync = new Map<string, Promise<RegistrySyncStatus>>()
  const syncingNow = new Set<string>()
  let activeOperations = 0
  let busy = false
  let timer: ReturnType<typeof setInterval> | null = null

  telemetry.emit({ event_type: 'session_started' })

  if (listRegistries(db, { includeRemoved: true }).length === 0) {
    seedDefaultRegistry()
  }

  function seedDefaultRegistry(): void {
    try {
      const canonical = canonicalizeRegistryUrl(DEFAULT_REGISTRY.url)
      insertRegistry(db, {
        url: DEFAULT_REGISTRY.url,
        branch: DEFAULT_REGISTRY.branch,
        enabled: true,
        autoUpdate: false,
        githubOwner: canonical.githubOwner,
        githubRepo: canonical.githubRepo,
        canonicalKey: canonical.canonicalKey,
      })
    } catch {}
  }

  function detectTargetsNow(): InstallTargetStatus[] {
    return detectInstallTargets(
      environment,
      readInstallRecords(db).map((record) => record.target)
    )
  }

  function mirrorPathFor(registryId: string): string {
    return join(mirrorsRoot, registryId)
  }

  function lockFor(registryId: string): ReturnType<typeof createAsyncMutex> {
    let lock = locks.get(registryId)
    if (!lock) {
      lock = createAsyncMutex()
      locks.set(registryId, lock)
    }
    return lock
  }

  function registryStatus(registryId: string): RegistrySyncStatus {
    if (syncingNow.has(registryId)) {
      const persisted = registrySyncStatusFromMarker(db, registryId)
      return { ...persisted, phase: 'syncing' }
    }
    return registrySyncStatusFromMarker(db, registryId)
  }

  function computeStatus(): SyncStatus {
    const enabled = listRegistries(db).filter((r) => r.enabled)
    return aggregateSyncStatus(enabled.map((r) => registryStatus(r.id)))
  }

  function isBusy(): boolean {
    return activeOperations > 0 || inFlightSync.size > 0
  }

  function signalBusyChange(): void {
    if (busy === isBusy()) return
    busy = isBusy()
    options.onBusyChange?.(busy)
  }

  async function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    activeOperations++
    signalBusyChange()
    try {
      return await operation()
    } finally {
      activeOperations--
      signalBusyChange()
    }
  }

  function emitStatus(): void {
    onSyncStatus?.(computeStatus())
  }

  function toRecord(registry: StoredRegistry): RegistryRecord {
    return {
      id: registry.id,
      url: registry.url,
      branch: registry.branch,
      enabled: registry.enabled,
      autoUpdate: registry.autoUpdate,
      githubOwner: registry.githubOwner,
      githubRepo: registry.githubRepo,
      colour: registry.colour,
      name: registry.name,
      syncStatus: registryStatus(registry.id),
    }
  }

  /** Sync one Registry; coalesces duplicate in-flight requests for the same id. */
  function doSync(registry: StoredRegistry): Promise<RegistrySyncStatus> {
    const existing = inFlightSync.get(registry.id)
    if (existing) return existing

    const run = lockFor(registry.id).runExclusive(async () => {
      syncingNow.add(registry.id)
      emitStatus()
      try {
        if (!isGitAvailable()) {
          recordMarkerFailure(db, registry.id, 'offline')
          return registrySyncStatusFromMarker(db, registry.id)
        }
        const result = await runSyncRegistry(db, {
          registryId: registry.id,
          url: registry.url,
          branch: registry.branch,
          mirrorPath: mirrorPathFor(registry.id),
        })
        telemetry.emit({
          event_type: 'sync_completed',
          registry_revision: result.revision,
          visible_skill_count: result.visibleSkillCount,
        })
        return registrySyncStatusFromMarker(db, registry.id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const reason = classifyGitError(redactGitError(message))
        recordMarkerFailure(db, registry.id, reason)
        return registrySyncStatusFromMarker(db, registry.id)
      } finally {
        syncingNow.delete(registry.id)
      }
    })

    const tracked = run
      .then(async (status) => {
        if (status.phase === 'synced') await applyAutoUpdates(registry.id)
        return status
      })
      .finally(() => {
        inFlightSync.delete(registry.id)
        signalBusyChange()
        emitStatus()
      })
    inFlightSync.set(registry.id, tracked)
    signalBusyChange()
    return tracked
  }

  async function applyAutoUpdates(registryId: string): Promise<void> {
    const registry = getRegistry(db, registryId)
    if (!registry?.enabled || !registry.autoUpdate || registry.removedAt !== null) return
    const catalogue = readCatalogue(db, environment).skills
    const report = reconcile({ db, environment, registryId })
    const pending = new Map<string, InstallTargetId[]>()
    for (const entry of report.entries) {
      if (entry.state !== 'update-available') continue
      const targets = pending.get(entry.folderName) ?? []
      targets.push(entry.target)
      pending.set(entry.folderName, targets)
    }
    if (pending.size === 0) return
    const mirrorRevision = await git(mirrorPathFor(registryId), 'rev-parse', 'HEAD')
    const result: AutoUpdateResult = {
      registryId,
      registryLabel: registryLabel(registry),
      updated: [],
      failed: [],
    }
    for (const [folderName, targets] of pending) {
      const current = getRegistry(db, registryId)
      if (!current?.enabled || !current.autoUpdate || current.removedAt !== null) break
      const name =
        catalogue.find(
          (skill) => skill.registryId === registryId && skill.folderName === folderName
        )?.name ?? folderName
      try {
        const installed = await runInstallOperation(
          { registryId, folderName, targets, mirrorRevision },
          'update',
          true
        )
        if (!installed) continue
        const updatedTargets = installed.perTarget
          .filter((target) => target.outcome === 'installed')
          .map((target) => target.target)
        if (updatedTargets.length > 0)
          result.updated.push({ folderName, name, targets: updatedTargets })
        const failures = installed.perTarget.filter((target) => target.outcome === 'failed')
        if (failures.length > 0)
          result.failed.push({
            folderName,
            name,
            reason: failures.map((target) => target.error ?? 'install failed').join('; '),
          })
      } catch (error) {
        result.failed.push({
          folderName,
          name,
          reason: redactError(
            redactGitError(error instanceof Error ? error.message : String(error))
          ),
        })
      }
    }
    if (result.updated.length > 0 || result.failed.length > 0) {
      options.onAutoUpdateResult?.(result)
      onCatalogueUpdated?.()
    }
  }

  async function refreshAll(): Promise<SyncAllResult> {
    const enabled = listRegistries(db).filter((r) => r.enabled)
    const registries = await runWithConcurrency(enabled, MAX_CONCURRENT_SYNCS, (r) => doSync(r))
    emitStatus()
    onCatalogueUpdated?.()
    return { registries }
  }

  /** After a removal/uninstall, drop a soft-removed Registry with no dependents. */
  function cleanupOrphanIfExhausted(registryId: string): void {
    const registry = getRegistry(db, registryId)
    if (!registry || registry.removedAt === null) return
    const installs = readInstallRecords(db, { registryId })
    if (installs.length > 0) return
    if (mirrorHasLiveSymlinkDependents(registryId)) return
    hardDeleteRegistry(db, registryId)
    try {
      rmSync(mirrorPathFor(registryId), { recursive: true, force: true })
    } catch {}
  }

  /**
   * True when any agent/canonical skill path is a symlink whose real path
   * lives under this Registry's mirror. Covers recorded install paths and the
   * candidate locations the bundled installer writes, including every folder
   * still in the Registry Snapshot to cover installs missing from SQLite. A live
   * symlink keeps the mirror even when SQLite has no install record left.
   */
  function mirrorHasLiveSymlinkDependents(registryId: string): boolean {
    const mirrorPath = mirrorPathFor(registryId)
    if (!existsSync(mirrorPath)) return false
    let mirrorRoot: string
    try {
      mirrorRoot = realpathSync(mirrorPath)
    } catch {
      return false
    }

    const candidates = new Set<string>()
    for (const rec of readInstallRecords(db, { registryId })) {
      for (const p of rec.paths) candidates.add(p)
      candidates.add(targetInstallPath(homeDir, rec.target, rec.folderName))
    }
    const folders = db
      .prepare(`SELECT DISTINCT folder_name FROM skill WHERE registry_id = ?`)
      .all(registryId) as { folder_name: string }[]
    const targets = detectTargetsNow().map((target) => target.id)
    for (const row of folders) {
      for (const target of targets) {
        candidates.add(targetInstallPath(homeDir, target, row.folder_name))
      }
    }

    for (const path of candidates) {
      try {
        if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) continue
        const real = realpathSync(path)
        if (real === mirrorRoot || real.startsWith(mirrorRoot + '/')) return true
      } catch {}
    }
    return false
  }

  /**
   * Finishes removals interrupted by a crash between hard-delete and mirror
   * removal, or left by an uninstall that cleared the last dependent.
   */
  function finishInterruptedRemovals(): void {
    for (const registry of listRegistries(db, { includeRemoved: true })) {
      if (registry.removedAt !== null) cleanupOrphanIfExhausted(registry.id)
    }
  }

  finishInterruptedRemovals()

  function runInstallOperation(req: InstallRequest, action: TelemetryAction): Promise<InstallResult>
  function runInstallOperation(
    req: InstallRequest,
    action: TelemetryAction,
    onlyUpdateAvailable: true
  ): Promise<InstallResult | null>
  async function runInstallOperation(
    req: InstallRequest,
    action: TelemetryAction,
    onlyUpdateAvailable = false
  ): Promise<InstallResult | null> {
    return trackOperation(() =>
      lockFor(req.registryId).runExclusive(async () => {
        const registry = getRegistry(db, req.registryId)
        if (!registry) {
          throw new Error(`Registry "${req.registryId}" is not configured`)
        }
        if (registry.removedAt !== null) {
          throw new Error(
            `Registry "${req.registryId}" has been removed. Its installations are orphaned and can only be uninstalled.`
          )
        }
        if (!registry.enabled) {
          throw new Error(
            `Registry "${req.registryId}" is disabled. Re-enable it before installing or updating its skills.`
          )
        }
        const marker = getMarker(db, req.registryId)
        if (marker?.stale && !req.acknowledgeStale) {
          throw new Error(
            'This registry snapshot is stale after a failed sync. Acknowledge staleness to proceed.'
          )
        }

        const mirrorPath = mirrorPathFor(req.registryId)
        const currentRevision = await git(mirrorPath, 'rev-parse', 'HEAD')
        if (onlyUpdateAvailable) {
          const report = reconcile({
            db,
            environment,
            registryId: req.registryId,
            folderName: req.folderName,
          })
          const targets = req.targets.filter((target) =>
            report.entries.some(
              (entry) => entry.target === target && entry.state === 'update-available'
            )
          )
          if (targets.length === 0) return null
          req = { ...req, targets }
        }
        const dimensions = readSkillTelemetryDimensions(db, req.registryId, req.folderName)
        const lifecycleRequest = {
          action,
          skillId: makeSkillId(req.registryId, req.folderName),
          targets: req.targets,
          ...dimensions,
        } satisfies InstallLifecycleRequest

        const result = await executeInstallLifecycle(
          telemetry,
          lifecycleRequest,
          async () => {
            const installResult = await installSkill(
              {
                db,
                registryId: req.registryId,
                mirrorPath,
                environment,
                currentRevision,
                runSkillsCli,
              },
              req
            )
            return {
              result: installResult,
              completion: {
                commitSha: installResult.provenanceSha,
                contentHash: installResult.contentHash,
                perTarget: installResult.perTarget,
              },
            }
          },
          (error) => ({
            revisionMismatch:
              (error instanceof Error ? error.message : String(error)) === REVISION_REFUSED_MESSAGE,
          })
        )
        onCatalogueUpdated?.()
        return result
      })
    )
  }

  if (syncIntervalMs > 0) {
    timer = setInterval(() => {
      void refreshAll()
    }, syncIntervalMs)
    timer.unref?.()
  }

  return {
    telemetry,
    getAutoDownloadAppUpdates: () => getAutoDownloadAppUpdates(db),
    setAutoDownloadAppUpdates: (enabled) => setAutoDownloadAppUpdates(db, enabled),
    isBusy,

    async syncNow(): Promise<SyncStatus> {
      await refreshAll()
      return computeStatus()
    },

    close() {
      if (timer) clearInterval(timer)
      db.close()
    },

    async detectTargets(): Promise<TargetDetection> {
      return { targets: detectTargetsNow(), agents: supportedAgents(environment) }
    },

    async install(req: InstallRequest): Promise<InstallResult> {
      return runInstallOperation(req, 'install')
    },

    async reconcile(req?: { registryId?: string; folderName?: string }): Promise<ReconcileReport> {
      return reconcile({
        db,
        environment,
        registryId: req?.registryId,
        folderName: req?.folderName,
      })
    },

    async repair(req: InstallRequest): Promise<InstallResult> {
      return runInstallOperation(req, 'update')
    },

    async uninstall(req: UninstallRequest): Promise<UninstallResult> {
      return trackOperation(async () => {
        const dimensions = readSkillTelemetryDimensions(db, req.registryId, req.folderName)
        const lifecycleRequest = {
          action: 'remove',
          skillId: makeSkillId(req.registryId, req.folderName),
          targets: req.targets,
          ...dimensions,
        } satisfies InstallLifecycleRequest
        const result = await executeInstallLifecycle(telemetry, lifecycleRequest, () =>
          lockFor(req.registryId).runExclusive(async () => {
            const uninstallResult = await uninstallSkill({ db, home: homeDir }, req)
            return {
              result: uninstallResult,
              completion: {
                perTarget: uninstallResult.perTarget.map((target): TargetResult => ({
                  target: target.target,
                  outcome: target.outcome,
                  method: 'copy',
                  paths: target.paths,
                  error: target.error,
                })),
              },
            }
          })
        )
        cleanupOrphanIfExhausted(req.registryId)
        onCatalogueUpdated?.()
        return result
      })
    },

    async getCatalogue(): Promise<CatalogueSnapshot> {
      const snapshot = readCatalogue(db, environment)
      return { skills: snapshot.skills, syncStatus: computeStatus() }
    },

    async refresh(): Promise<SyncAllResult> {
      return refreshAll()
    },

    async getSyncStatus(): Promise<SyncStatus> {
      return computeStatus()
    },

    async listRegistries(): Promise<RegistryRecord[]> {
      return listRegistries(db).map(toRecord)
    },

    async addRegistry(req: AddRegistryRequest): Promise<RegistryRecord> {
      const canonical = canonicalizeRegistryUrl(req.url)
      const existing = findByCanonicalKey(db, canonical.canonicalKey)
      if (existing) {
        throw new Error(
          `A registry for ${registryLabel(existing)} is already configured (id ${existing.id}).`
        )
      }

      let branch = req.branch?.trim()
      if (!branch) {
        if (!isGitAvailable()) {
          throw new Error('Git is unavailable; specify a branch for this registry.')
        }
        try {
          branch = await detectDefaultBranch(canonical.url)
        } catch {
          throw new Error(
            'Could not detect the default branch; specify a branch for this registry.'
          )
        }
      }

      const stored = insertRegistry(db, {
        url: canonical.url,
        branch,
        enabled: req.enabled ?? true,
        autoUpdate: false,
        githubOwner: canonical.githubOwner,
        githubRepo: canonical.githubRepo,
        canonicalKey: canonical.canonicalKey,
      })
      if (stored.enabled) {
        await doSync(stored)
      }
      onCatalogueUpdated?.()
      emitStatus()
      return toRecord(getRegistry(db, stored.id)!)
    },

    async updateRegistry(req: UpdateRegistryRequest): Promise<RegistryRecord> {
      const current = getRegistry(db, req.id)
      if (!current || current.removedAt !== null) {
        throw new Error(`Registry "${req.id}" is not configured`)
      }

      const fields: Parameters<typeof updateRegistry>[2] = {}
      if (req.url !== undefined && req.url.trim() !== current.url) {
        const canonical = canonicalizeRegistryUrl(req.url)
        const clash = findByCanonicalKey(db, canonical.canonicalKey)
        if (clash && clash.id !== current.id) {
          throw new Error(
            `A registry for ${registryLabel(clash)} is already configured (id ${clash.id}).`
          )
        }
        fields.url = canonical.url
        fields.githubOwner = canonical.githubOwner
        fields.githubRepo = canonical.githubRepo
        fields.canonicalKey = canonical.canonicalKey
      }
      if (req.branch !== undefined && req.branch.trim() && req.branch.trim() !== current.branch) {
        fields.branch = req.branch.trim()
      }
      if (req.enabled !== undefined) {
        fields.enabled = req.enabled
      }

      if (req.autoUpdate !== undefined) {
        fields.autoUpdate = req.autoUpdate
      }

      if (req.colour !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(req.colour)) {
          throw new Error(`"${req.colour}" is not a #rrggbb colour.`)
        }
        fields.colour = req.colour.toLowerCase()
      }

      if (req.name !== undefined) {
        const name = req.name.trim()
        if (name.length > MAX_REGISTRY_NAME_LENGTH) {
          throw new Error(`A registry name can be at most ${MAX_REGISTRY_NAME_LENGTH} characters.`)
        }
        fields.name = name === '' ? null : name
      }

      const updated = updateRegistry(db, req.id, fields)

      const branchOrUrlChanged = fields.url !== undefined || fields.branch !== undefined
      const enabledFromDisabled = req.enabled === true && !current.enabled
      const autoUpdateEnabled = req.autoUpdate === true && !current.autoUpdate
      if (updated.enabled && (branchOrUrlChanged || enabledFromDisabled || autoUpdateEnabled)) {
        await doSync(updated)
      }
      onCatalogueUpdated?.()
      emitStatus()
      return toRecord(getRegistry(db, req.id)!)
    },

    async removeRegistry(id: string): Promise<void> {
      const current = getRegistry(db, id)
      if (!current) return
      softRemoveRegistry(db, id)
      cleanupOrphanIfExhausted(id)
      onCatalogueUpdated?.()
      emitStatus()
    },

    async listSkillFiles(req: SkillFileRequest): Promise<SkillFileList> {
      return listSkillFiles({ db, mirrorPathFor }, req)
    },

    async readSkillFile(req: SkillFileReadRequest): Promise<SkillFileContent> {
      return readSkillFile({ db, mirrorPathFor }, req)
    },

    async syncRegistry(id: string): Promise<RegistrySyncStatus> {
      const registry = getRegistry(db, id)
      if (!registry) {
        throw new Error(`Registry "${id}" is not configured`)
      }
      if (!registry.enabled || registry.removedAt !== null) {
        return registryStatus(id)
      }
      const status = await doSync(registry)
      onCatalogueUpdated?.()
      emitStatus()
      return status
    },
  }
}
