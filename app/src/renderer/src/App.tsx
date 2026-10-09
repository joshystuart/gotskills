import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type {
  AutoUpdateResult,
  CatalogueSnapshot,
  InstallRequest,
  InstallResult,
  InstallTargetId,
  InstallTargetStatus,
  RegistryMenuAction,
  RegistryRecord,
  RendererApi,
  SkillSummary,
  SupportedAgent,
  SyncStatus,
} from '../../shared/ipc'
import { deriveInstallWork, runBulkInstall } from './bulkInstall'
import { runBulkUpdate } from './bulkUpdate'
import { AppUpdateSettings } from './AppUpdateSettings'
import { AppUpdateBanner } from './AppUpdateBanner'
import { useAppUpdate } from './useAppUpdate'
import { AutoUpdateNotice } from './AutoUpdateNotice'
import { CatalogueList } from './CatalogueList'
import { ConfirmDialog } from './ConfirmDialog'
import { SettingsView } from './SettingsView'
import { Sidebar } from './Sidebar'
import { SkillDetailPanel } from './SkillDetailPanel'
import { SkillFilesSection } from './SkillFilesSection'
import {
  bannerMessage,
  deriveUpdateWork,
  filterByRegistry,
  isInstalledLike,
  registryDotColour,
  registryRecordLabel,
  searchSkills,
  skillsInView,
  targetLabel,
  viewLabel,
  type CatalogueView,
  type RegistryFilter,
} from './cataloguePresentation'
import {
  EMPTY_SELECTION,
  nextSelection,
  pruneSelection,
  type CatalogueSelection,
  type ClickModifiers,
} from './catalogueSelection'
import { SelectionBar, type BulkInstallPhase } from './SelectionBar'
import { Toolbar } from './Toolbar'
import { UpdateAllRegion, type UpdateAllPhase } from './UpdateAllRegion'

interface AppProps {
  api: RendererApi
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function App({ api }: AppProps): JSX.Element {
  const appUpdate = useAppUpdate(api)
  const [autoUpdateNotices, setAutoUpdateNotices] = useState<
    { id: number; result: AutoUpdateResult }[]
  >([])
  const nextAutoUpdateNoticeId = useRef(0)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<CatalogueView>('all')
  const [registryFilter, setRegistryFilter] = useState<RegistryFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selection, setSelection] = useState<CatalogueSelection>(EMPTY_SELECTION)
  const [refreshing, setRefreshing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const [registries, setRegistries] = useState<RegistryRecord[]>([])
  const [addUrl, setAddUrl] = useState('')
  const [addBranch, setAddBranch] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editBranch, setEditBranch] = useState('')
  const [branchWarn, setBranchWarn] = useState(false)
  const [registryBusy, setRegistryBusy] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [targets, setTargets] = useState<InstallTargetStatus[]>([])
  const [agents, setAgents] = useState<SupportedAgent[]>([])
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [lastInstall, setLastInstall] = useState<InstallResult | null>(null)
  const [acknowledgedStale, setAcknowledgedStale] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<InstallTargetId[] | null>(null)
  const [pendingRegistryRemoval, setPendingRegistryRemoval] = useState<RegistryRecord | null>(null)
  const [highlightedRegistryId, setHighlightedRegistryId] = useState<string | null>(null)
  const [fileViewerOpen, setFileViewerOpen] = useState(false)
  const [updateAllPhase, setUpdateAllPhase] = useState<UpdateAllPhase>({ kind: 'idle' })
  /**
   * The single run-level stale-Registry acknowledgement; deliberately one
   * per run, reset to off when the summary is dismissed.
   */
  const [runAcknowledgeStale, setRunAcknowledgeStale] = useState(false)
  const [runInFlight, setRunInFlight] = useState(false)
  const [installChips, setInstallChips] = useState<InstallTargetId[]>([])
  const [installPhase, setInstallPhase] = useState<BulkInstallPhase>({ kind: 'idle' })
  const [installAcknowledgeStale, setInstallAcknowledgeStale] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  /**
   * Kept live so a bulk run always dispatches against the current sync
   * status, not a snapshot captured when the run started.
   */
  const statusRef = useRef<SyncStatus | null>(null)
  /**
   * Mirrors runInFlight for the onCatalogueUpdated subscription below, which
   * is registered once and would otherwise see a stale closure.
   */
  const runInFlightRef = useRef(false)
  /**
   * Set by the run region's Cancel control; the bulk loop checks it before
   * each dispatch, so the item in flight always runs to completion and no
   * Skill is left half-installed.
   */
  const cancelRunRef = useRef(false)

  /** Shows a fresh skill list and drops selected skills it no longer lists. */
  function applySkills(next: SkillSummary[]): void {
    setSkills(next)
    setSelection((current) =>
      pruneSelection(
        current,
        next.map((s) => s.id)
      )
    )
  }

  async function loadCatalogue(
    isCurrent: () => boolean = () => true
  ): Promise<CatalogueSnapshot | null> {
    const [snapshot, detected] = await Promise.all([api.getCatalogue(), api.detectTargets()])
    if (!isCurrent()) return null
    applySkills(snapshot.skills)
    setTargets(detected.targets)
    setAgents(detected.agents)
    return snapshot
  }

  useEffect(() => {
    let mounted = true

    async function pullCatalogue(): Promise<void> {
      const snapshot = await loadCatalogue(() => mounted)
      if (!snapshot) return
      setStatus((prev) => (prev?.phase === 'syncing' ? prev : snapshot.syncStatus))
    }

    void api.getSyncStatus().then((s) => {
      if (mounted) {
        statusRef.current = s
        setStatus(s)
      }
    })
    void pullCatalogue()
    void api.listRegistries().then((list) => {
      if (mounted) setRegistries(list)
    })

    const offStatus = api.onSyncStatus((s) => {
      if (!mounted) return
      statusRef.current = s
      setStatus(s)
    })
    const offCatalogue = api.onCatalogueUpdated(() => {
      if (runInFlightRef.current) return
      void pullCatalogue()
      void api.listRegistries().then((list) => {
        if (mounted) setRegistries(list)
      })
    })

    const offAutoUpdate = api.onAutoUpdateResult((result) => {
      if (!mounted) return
      const notice = { id: nextAutoUpdateNoticeId.current++, result }
      setAutoUpdateNotices((notices) => [notice, ...notices])
    })

    return () => {
      mounted = false
      offStatus()
      offCatalogue()
      offAutoUpdate()
    }
  }, [api])

  useEffect(() => {
    setInstallError(null)
    setLastInstall(null)
    setPendingRemoval(null)
    setAcknowledgedStale(false)
    setFileViewerOpen(false)
  }, [selectedId])

  useEffect(() => {
    if (
      registryFilter !== 'all' &&
      !registries.some((registry) => registry.id === registryFilter)
    ) {
      setRegistryFilter('all')
    }
  }, [registries, registryFilter])

  useEffect(() => {
    if (!selectedId) return
    const visible = searchSkills(
      filterByRegistry(skillsInView(skills, view), registryFilter),
      searchQuery
    )
    if (!visible.some((skill) => skill.id === selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, skills, view, registryFilter, searchQuery])

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await api.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const openSettings = useCallback((): void => {
    setEditingId(null)
    setBranchWarn(false)
    setAddUrl('')
    setAddBranch('')
    setAddError(null)
    setRegistryError(null)
    setSettingsOpen(true)
  }, [])

  const confirmOpen = pendingRemoval !== null || pendingRegistryRemoval !== null

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey || confirmOpen) return
      if (event.key === ',') {
        event.preventDefault()
        openSettings()
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSettingsOpen(false)
        setSearchFocusRequest((count) => count + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, confirmOpen])

  useEffect(() => {
    setSelection(EMPTY_SELECTION)
  }, [view, searchQuery, registryFilter])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !confirmOpen) setSelection(EMPTY_SELECTION)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmOpen])

  useEffect(() => {
    if (searchFocusRequest > 0) searchRef.current?.focus()
  }, [searchFocusRequest])

  function selectView(next: CatalogueView): void {
    setView(next)
    setSettingsOpen(false)
  }

  function toggleRegistry(registryId: string): void {
    setRegistryFilter((current) => (current === registryId ? 'all' : registryId))
    setSettingsOpen(false)
  }

  useEffect(() => {
    if (!highlightedRegistryId) return
    const timer = setTimeout(() => setHighlightedRegistryId(null), 2000)
    return () => clearTimeout(timer)
  }, [highlightedRegistryId])

  function showRegistryInSettings(registry: RegistryRecord): void {
    openSettings()
    setHighlightedRegistryId(registry.id)
  }

  async function onRegistryMenu(
    registry: RegistryRecord,
    position?: { x: number; y: number }
  ): Promise<void> {
    const action = await api.showRegistryMenu({
      registryId: registry.id,
      busy,
      ...(position ? { position } : {}),
    })
    const run: Record<RegistryMenuAction, (registry: RegistryRecord) => unknown> = {
      sync: onSyncRegistry,
      'toggle-enabled': onToggleEnabled,
      'toggle-auto-update': onToggleAutoUpdate,
      'show-settings': showRegistryInSettings,
      remove: setPendingRegistryRemoval,
    }
    if (action) await run[action](registry)
  }

  /** Re-pull registries + catalogue after any Registry mutation. */
  async function refreshAfterRegistryChange(): Promise<void> {
    const [list, snapshot] = await Promise.all([api.listRegistries(), api.getCatalogue()])
    setRegistries(list)
    applySkills(snapshot.skills)
    setStatus(snapshot.syncStatus)
  }

  /** True when this Registry currently supplies at least one installed Skill. */
  function registrySuppliesInstalled(registryId: string): boolean {
    return skills.some((s) => s.registryId === registryId && isInstalledLike(s))
  }

  async function onAddRegistry(event: FormEvent): Promise<void> {
    event.preventDefault()
    const url = addUrl.trim()
    if (!url) return
    setAddBusy(true)
    setAddError(null)
    try {
      const branch = addBranch.trim()
      await api.addRegistry(branch ? { url, branch } : { url })
      setAddUrl('')
      setAddBranch('')
      await refreshAfterRegistryChange()
    } catch (err) {
      setAddError(errorMessage(err))
    } finally {
      setAddBusy(false)
    }
  }

  function startEdit(registry: RegistryRecord): void {
    setEditingId(registry.id)
    setEditUrl(registry.url)
    setEditBranch(registry.branch)
    setBranchWarn(false)
    setRegistryError(null)
  }

  function cancelEdit(): void {
    setEditingId(null)
    setBranchWarn(false)
  }

  async function commitEdit(registry: RegistryRecord): Promise<void> {
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.updateRegistry({
        id: registry.id,
        url: editUrl.trim(),
        branch: editBranch.trim(),
      })
      setEditingId(null)
      setBranchWarn(false)
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  function attemptEdit(event: FormEvent, registry: RegistryRecord): void {
    event.preventDefault()
    const branchChanged = editBranch.trim() !== registry.branch
    if (branchChanged && registrySuppliesInstalled(registry.id) && !branchWarn) {
      setBranchWarn(true)
      return
    }
    void commitEdit(registry)
  }

  async function onToggleEnabled(registry: RegistryRecord): Promise<void> {
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.updateRegistry({ id: registry.id, enabled: !registry.enabled })
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  async function onToggleAutoUpdate(registry: RegistryRecord): Promise<void> {
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.updateRegistry({ id: registry.id, autoUpdate: !registry.autoUpdate })
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  async function onChangeColour(registry: RegistryRecord, colour: string): Promise<void> {
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.updateRegistry({ id: registry.id, colour })
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  async function onSyncRegistry(registry: RegistryRecord): Promise<void> {
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.syncRegistry(registry.id)
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  async function onRemoveRegistry(registry: RegistryRecord): Promise<void> {
    setPendingRegistryRemoval(null)
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await api.removeRegistry(registry.id)
      if (editingId === registry.id) setEditingId(null)
      await refreshAfterRegistryChange()
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryBusy(false)
    }
  }

  const visibleTargets = targets.filter((t) => t.visible)
  const visibleTargetIds = visibleTargets.map((t) => t.id)
  const visibleSkills = searchSkills(
    filterByRegistry(skillsInView(skills, view), registryFilter),
    searchQuery
  )
  const selected = skills.find((s) => s.id === selectedId) ?? null
  const registriesById = new Map(registries.map((r) => [r.id, r]))

  /** Installed entries whose supplying Registry is disabled or removed (orphaned). */
  function isInstalledOnly(skill: SkillSummary): boolean {
    return skill.orphaned || registriesById.get(skill.registryId)?.enabled === false
  }

  const installedOnly = selected ? isInstalledOnly(selected) : false

  /** The synced HEAD revision for the Registry that supplies a skill. */
  function revisionFor(skill: SkillSummary): string | undefined {
    return status?.registries.find((r) => r.registryId === skill.registryId)?.revision
  }

  /** Live accessor for a Registry's current revision, for the bulk run. */
  function revisionForRegistry(registryId: string): string | undefined {
    return statusRef.current?.registries.find((r) => r.registryId === registryId)?.revision
  }

  function onRowClick(skillId: string, modifiers: ClickModifiers): void {
    const multi = modifiers.meta || modifiers.shift
    if (multi && runInFlight) return
    const next = nextSelection(
      selection,
      visibleSkills.map((s) => s.id),
      skillId,
      modifiers,
      selectedId
    )
    if (selection.ids.size === 0 && next.ids.size > 0) {
      setInstallChips(visibleTargetIds)
      setInstallAcknowledgeStale(false)
    }
    setSelection(next)
    setSelectedId(skillId)
  }

  const showSelectionBar = selection.ids.size >= 2 || installPhase.kind !== 'idle'
  const installWork = deriveInstallWork(
    skills.filter((s) => selection.ids.has(s.id)),
    visibleTargetIds.filter((id) => installChips.includes(id)),
    { acknowledgeStale: installAcknowledgeStale, isInstalledOnly, status }
  )

  function toggleInstallChip(target: InstallTargetId): void {
    setInstallChips((chips) =>
      chips.includes(target) ? chips.filter((t) => t !== target) : [...chips, target]
    )
  }

  async function onRunInstallSelection(): Promise<void> {
    const work = installWork
    if (runInFlight || work.items.length === 0) return
    runInFlightRef.current = true
    cancelRunRef.current = false
    setRunInFlight(true)
    try {
      const result = await runBulkInstall({
        api,
        work,
        getRevision: revisionForRegistry,
        onProgress: (progress) => setInstallPhase({ kind: 'installing', ...progress }),
        isCancelled: () => cancelRunRef.current,
      })
      setInstallPhase({ kind: 'summary', ...result, disclosures: work.disclosures })
    } finally {
      runInFlightRef.current = false
      setRunInFlight(false)
      setSelection(EMPTY_SELECTION)
      await loadCatalogue()
    }
  }

  function dismissInstallSummary(): void {
    setInstallPhase({ kind: 'idle' })
    setInstallAcknowledgeStale(false)
  }

  const updateAllWork = deriveUpdateWork(skills, status)
  const updateAllItems = updateAllWork.all

  async function onRunUpdateAll(): Promise<void> {
    if (runInFlight || updateAllItems.length === 0) return
    runInFlightRef.current = true
    cancelRunRef.current = false
    setRunInFlight(true)
    setUpdateAllPhase({ kind: 'refreshing' })
    try {
      const result = await runBulkUpdate({
        api,
        getRevision: revisionForRegistry,
        onProgress: (progress) => {
          setUpdateAllPhase({
            kind: 'updating',
            index: progress.index,
            total: progress.total,
            item: progress.item,
          })
        },
        isCancelled: () => cancelRunRef.current,
        acknowledgeStale: runAcknowledgeStale,
      })
      setUpdateAllPhase({
        kind: 'summary',
        updated: result.updated,
        failures: result.failures,
        heldBack: result.heldBack,
        cancelled: result.cancelled,
      })
    } catch (err) {
      setUpdateAllPhase({ kind: 'failed', reason: errorMessage(err) })
      setRunAcknowledgeStale(false)
    } finally {
      runInFlightRef.current = false
      setRunInFlight(false)
      await loadCatalogue()
    }
  }

  function cancelUpdateAll(): void {
    cancelRunRef.current = true
  }

  function dismissUpdateAllSummary(): void {
    setUpdateAllPhase({ kind: 'idle' })
    setRunAcknowledgeStale(false)
  }

  function buildInstallRequest(
    skill: SkillSummary,
    installTargets: InstallTargetId[],
    revision: string
  ): InstallRequest {
    const req: InstallRequest = {
      registryId: skill.registryId,
      folderName: skill.folderName,
      targets: installTargets,
      mirrorRevision: revision,
    }
    if (skill.stale && acknowledgedStale) req.acknowledgeStale = true
    return req
  }

  async function runInstall(installTargets: InstallTargetId[]): Promise<void> {
    if (!selected || installTargets.length === 0) return
    const revision = revisionFor(selected)
    if (!revision) {
      setInstallError('Catalogue has no synced revision yet. Refresh and try again.')
      return
    }
    setInstalling(true)
    setInstallError(null)
    try {
      const result = await api.install(buildInstallRequest(selected, installTargets, revision))
      setLastInstall(result)
      await loadCatalogue()
    } catch (err) {
      setInstallError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }

  async function runRepair(repairTargets: InstallTargetId[]): Promise<void> {
    if (!selected || repairTargets.length === 0) return
    const revision = revisionFor(selected)
    if (!revision) {
      setInstallError('Catalogue has no synced revision yet. Refresh and try again.')
      return
    }
    setInstalling(true)
    setInstallError(null)
    try {
      const result = await api.repair(buildInstallRequest(selected, repairTargets, revision))
      setLastInstall(result)
      await loadCatalogue()
    } catch (err) {
      setInstallError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }

  async function runUninstall(targetsToRemove: InstallTargetId[]): Promise<void> {
    if (!selected || targetsToRemove.length === 0) return
    setPendingRemoval(null)
    setInstalling(true)
    setInstallError(null)
    try {
      await api.uninstall({
        registryId: selected.registryId,
        folderName: selected.folderName,
        targets: targetsToRemove,
      })
      await loadCatalogue()
      const snapshot = await api.getCatalogue()
      if (!snapshot.skills.some((s) => s.id === selectedId)) {
        setSelectedId(null)
      }
    } catch (err) {
      setInstallError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }

  const viewCounts: Record<CatalogueView, number> = {
    all: skillsInView(skills, 'all').length,
    installed: skillsInView(skills, 'installed').length,
    updates: skillsInView(skills, 'updates').length,
  }
  const registryCounts = new Map<string, number>()
  for (const skill of skills) {
    registryCounts.set(skill.registryId, (registryCounts.get(skill.registryId) ?? 0) + 1)
  }
  const selectedRegistry = registries.find((registry) => registry.id === registryFilter) ?? null
  const banner = status ? bannerMessage(status) : null
  const emptyMessage =
    status?.phase === 'syncing'
      ? 'Syncing catalogue…'
      : searchQuery.trim()
        ? 'No skills match your search.'
        : registryFilter !== 'all'
          ? 'No skills from this registry.'
          : status?.reason === 'empty' && view === 'all'
            ? 'No skills found — check the repo URL in Settings'
            : view === 'updates'
              ? 'No updates available.'
              : view === 'installed'
                ? 'No installed skills.'
                : 'No skills yet.'
  const busy =
    refreshing || registryBusy || installing || runInFlight || status?.phase === 'syncing'
  const restartDisabled = busy || addBusy
  const staleBlocked = !!selected?.stale && !acknowledgedStale
  const installDisabled =
    busy ||
    visibleTargetIds.length === 0 ||
    !(selected && revisionFor(selected)) ||
    !!selected?.softDeleted ||
    installedOnly ||
    staleBlocked
  const repairDisabled = busy || !(selected && revisionFor(selected)) || staleBlocked

  const updateTargets =
    selected?.perTarget.filter((p) => p.state === 'update-available').map((p) => p.target) ?? []
  const repairTargets =
    selected?.perTarget.filter((p) => p.state === 'needs-repair').map((p) => p.target) ?? []
  const removeTargets =
    selected?.perTarget
      .filter((p) =>
        ['installed', 'update-available', 'needs-repair', 'removed-from-registry'].includes(p.state)
      )
      .map((p) => p.target) ?? []
  const showInstallControls = !!selected && !selected.softDeleted && !installedOnly

  return (
    <div className="app">
      <Sidebar
        status={status}
        view={view}
        counts={viewCounts}
        settingsOpen={settingsOpen}
        registries={registries}
        registryCounts={registryCounts}
        registryFilter={registryFilter}
        onSelectRegistry={toggleRegistry}
        onRegistryMenu={onRegistryMenu}
        onSelectView={selectView}
        onOpenSettings={openSettings}
      />

      <div className="content">
        <Toolbar
          title={settingsOpen ? 'Settings' : viewLabel(view)}
          subtitle={
            settingsOpen || !selectedRegistry ? null : registryRecordLabel(selectedRegistry)
          }
          subtitleColour={
            settingsOpen || !selectedRegistry ? null : registryDotColour(selectedRegistry)
          }
          settingsOpen={settingsOpen}
          searchQuery={searchQuery}
          searchRef={searchRef}
          refreshDisabled={busy}
          onSearchChange={setSearchQuery}
          onRefresh={() => void onRefresh()}
        />

        <AppUpdateBanner
          state={appUpdate.state}
          onDownload={appUpdate.download}
          onRestart={appUpdate.restart}
          restartDisabled={restartDisabled}
        />

        {banner ? (
          <div className="banner" role="alert">
            {banner}
          </div>
        ) : null}

        {settingsOpen ? (
          <SettingsView
            appUpdateSettings={<AppUpdateSettings api={api} state={appUpdate.state} />}
            registries={registries}
            agents={agents}
            registryBusy={registryBusy}
            registryError={registryError}
            highlightedRegistryId={highlightedRegistryId}
            editForm={{
              editingId,
              url: editUrl,
              branch: editBranch,
              branchWarn,
              onUrlChange: setEditUrl,
              onBranchChange: setEditBranch,
              onStart: startEdit,
              onCancel: cancelEdit,
              onAttempt: attemptEdit,
              onCommit: commitEdit,
            }}
            addForm={{
              url: addUrl,
              branch: addBranch,
              busy: addBusy,
              error: addError,
              onUrlChange: setAddUrl,
              onBranchChange: setAddBranch,
              onSubmit: onAddRegistry,
            }}
            onToggleEnabled={onToggleEnabled}
            onToggleAutoUpdate={onToggleAutoUpdate}
            onChangeColour={onChangeColour}
            onSyncRegistry={onSyncRegistry}
            onRemoveRegistry={setPendingRegistryRemoval}
          />
        ) : (
          <>
            {showSelectionBar ? (
              <SelectionBar
                count={selection.ids.size}
                work={installWork}
                phase={installPhase}
                targets={visibleTargets}
                chosenTargets={installChips}
                busy={busy}
                acknowledgeStale={installAcknowledgeStale}
                onAcknowledgeStale={setInstallAcknowledgeStale}
                onToggleTarget={toggleInstallChip}
                onClear={() => setSelection(EMPTY_SELECTION)}
                onInstall={() => void onRunInstallSelection()}
                onCancel={cancelUpdateAll}
                onDismiss={dismissInstallSummary}
              />
            ) : (
              <UpdateAllRegion
                items={updateAllItems}
                phase={updateAllPhase}
                disabled={busy}
                onRunAll={() => void onRunUpdateAll()}
                onCancel={cancelUpdateAll}
                onDismissSummary={dismissUpdateAllSummary}
                disclosures={updateAllWork.disclosures}
                acknowledgeStale={runAcknowledgeStale}
                onAcknowledgeStale={setRunAcknowledgeStale}
              />
            )}
            {autoUpdateNotices.map((notice) => (
              <AutoUpdateNotice
                key={notice.id}
                result={notice.result}
                onDismiss={() =>
                  setAutoUpdateNotices((notices) => notices.filter((item) => item.id !== notice.id))
                }
              />
            ))}
            <main className="split">
              <section className="pane catalogue" aria-label="Catalogue">
                <CatalogueList
                  skills={visibleSkills}
                  targets={visibleTargets}
                  selectedId={selectedId}
                  selectedIds={selection.ids}
                  emptyMessage={emptyMessage}
                  registriesById={registriesById}
                  onRowClick={onRowClick}
                />
              </section>

              {selected ? (
                <SkillDetailPanel
                  skill={selected}
                  targets={visibleTargets}
                  installedOnly={installedOnly}
                  installActions={{
                    visible: showInstallControls,
                    disabled: installDisabled,
                    installing,
                    updateTargets,
                    onInstall: runInstall,
                    onUpdate: runRepair,
                  }}
                  repairRemove={{
                    repairTargets,
                    repairDisabled,
                    removeTargets,
                    removeDisabled: busy,
                    onRepair: runRepair,
                    onRemove: setPendingRemoval,
                  }}
                  fileViewerOpen={fileViewerOpen}
                  acknowledgedStale={acknowledgedStale}
                  installError={installError}
                  lastInstall={lastInstall}
                  filesSection={
                    <SkillFilesSection
                      api={api}
                      skill={selected}
                      installedOnly={installedOnly}
                      onFileOpenChange={setFileViewerOpen}
                    />
                  }
                  onAcknowledgedStaleChange={setAcknowledgedStale}
                  onClose={() => setSelectedId(null)}
                />
              ) : null}
            </main>
          </>
        )}
      </div>

      {pendingRemoval && selected ? (
        <ConfirmDialog
          title="Remove skill?"
          confirmLabel="Remove"
          confirmDisabled={busy}
          onConfirm={() => void runUninstall(pendingRemoval)}
          onCancel={() => setPendingRemoval(null)}
        >
          {pendingRemoval.length === 1
            ? `Remove “${selected.name}” from ${targetLabel(targets, pendingRemoval[0])}?`
            : `Remove “${selected.name}” from installed apps on this Mac?`}
        </ConfirmDialog>
      ) : null}

      {pendingRegistryRemoval ? (
        <ConfirmDialog
          title="Remove registry?"
          confirmLabel="Remove registry"
          confirmDisabled={registryBusy}
          onConfirm={() => void onRemoveRegistry(pendingRegistryRemoval)}
          onCancel={() => setPendingRegistryRemoval(null)}
        >
          Remove “{registryRecordLabel(pendingRegistryRemoval)}” from your registries? Skills
          already installed from it stay installed but will no longer receive updates.
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
