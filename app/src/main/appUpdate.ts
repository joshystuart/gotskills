import type { EventEmitter } from 'node:events'
import type { AppUpdateState } from '../shared/ipc'

export interface AppUpdater extends Pick<EventEmitter, 'on' | 'removeListener'> {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface AppUpdateOptions {
  updater: AppUpdater
  getAutoDownload: () => boolean
  setAutoDownload: (enabled: boolean) => void
  packaged: boolean
  currentVersion: string
  onState: (state: AppUpdateState) => void
  log: (error: unknown) => void
  isBusy: () => boolean
}

export function createAppUpdate({
  updater,
  packaged,
  currentVersion,
  onState,
  log,
  getAutoDownload,
  setAutoDownload,
  isBusy,
}: AppUpdateOptions) {
  let state: AppUpdateState = { kind: 'idle', currentVersion }
  let stateBeforeManualCheck: AppUpdateState = state
  let checking = false
  let manualCheck = false
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners: [string, Parameters<AppUpdater['on']>[1]][] = []

  function publish(next: AppUpdateState): void {
    if (closed) return
    state = next
    onState(state)
  }

  function listen(event: string, listener: Parameters<AppUpdater['on']>[1]): void {
    updater.on(event, listener)
    listeners.push([event, listener])
  }

  function downloadFailed(error: unknown): void {
    if (state.kind !== 'downloading') return
    publish({
      kind: 'download-failed',
      currentVersion,
      version: state.version,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  async function download(): Promise<void> {
    if (!packaged || closed || (state.kind !== 'available' && state.kind !== 'download-failed'))
      return
    publish({ kind: 'downloading', currentVersion, version: state.version, percent: 0 })
    try {
      await updater.downloadUpdate()
    } catch (error) {
      downloadFailed(error)
    }
  }

  function canCheck(): boolean {
    return state.kind === 'idle' || state.kind === 'available' || state.kind === 'download-failed'
  }

  function checkResult(result: 'up-to-date' | 'error', error?: unknown): void {
    if (!manualCheck || state.kind !== 'checking') return
    if (result === 'error' && stateBeforeManualCheck.kind !== 'idle') {
      log(error)
      publish(stateBeforeManualCheck)
      return
    }
    publish({
      kind: 'idle',
      currentVersion,
      lastCheck: {
        at: new Date().toISOString(),
        result,
        ...(error === undefined
          ? {}
          : { message: error instanceof Error ? error.message : String(error) }),
      },
    })
  }

  async function check(manual = false): Promise<void> {
    if (!packaged || closed || !canCheck()) return
    if (manual) {
      manualCheck = true
      stateBeforeManualCheck = state
      publish({ kind: 'checking', currentVersion })
    }
    if (checking) return
    checking = true
    try {
      await updater.checkForUpdates()
      checkResult('up-to-date')
    } catch (error) {
      if (manualCheck) checkResult('error', error)
      else log(error)
    } finally {
      checking = false
      manualCheck = false
    }
  }

  if (packaged) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    listen('update-available', ({ version }: { version: string }) => {
      if (version.includes('-') || !(canCheck() || state.kind === 'checking')) return
      publish({ kind: 'available', currentVersion, version })
      if (getAutoDownload()) void download()
    })
    listen('update-not-available', () => checkResult('up-to-date'))
    listen('download-progress', ({ percent }: { percent: number }) => {
      if (state.kind !== 'downloading') return
      publish({ ...state, percent })
    })
    listen('update-downloaded', ({ version }: { version: string }) => {
      if (state.kind !== 'downloading') return
      publish({ kind: 'ready', currentVersion, version, waiting: isBusy() })
    })
    listen('error', (error: unknown) => {
      if (state.kind === 'downloading') downloadFailed(error)
      else if (manualCheck) checkResult('error', error)
      else log(error)
    })
    void check()
    timer = setInterval(() => void check(), 4 * 60 * 60 * 1000)
  }

  return {
    getState: () => state,
    check: () => check(true),
    getAutoDownload,
    setAutoDownload,
    download,
    busyChanged: () => {
      if (state.kind === 'ready' && state.waiting !== isBusy())
        publish({ ...state, waiting: isBusy() })
    },
    restart: () => {
      if (packaged && !closed && !isBusy() && state.kind === 'ready')
        updater.quitAndInstall(false, true)
    },
    close: () => {
      closed = true
      clearInterval(timer)
      for (const [event, listener] of listeners) updater.removeListener(event, listener)
    },
  }
}
