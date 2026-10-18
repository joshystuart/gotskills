import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  IpcEvent,
  IpcRequest,
  InstallationCollisionError,
  type RendererApi,
  type Unsubscribe,
} from '../../shared/ipc'

type Command = keyof typeof IpcRequest

interface TauriFailure {
  kind: string
  message: string
  occupant?: 'managed' | 'external'
  folderName?: string
  target?: string
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function isFailure(value: unknown): value is TauriFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TauriFailure).kind === 'string' &&
    typeof (value as TauriFailure).message === 'string'
  )
}

/** Rebuild the Error a rejected command describes. */
export function toError(failure: unknown): Error {
  if (failure instanceof Error) return failure
  if (isFailure(failure)) {
    if (failure.kind === 'installation-collision') {
      return new InstallationCollisionError(
        failure.message,
        failure.occupant ?? 'external',
        failure.folderName ?? '',
        failure.target ?? ''
      )
    }
    return new Error(failure.message)
  }
  return new Error(typeof failure === 'string' ? failure : 'Unknown error')
}

async function call<T>(command: Command, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(snakeCase(command), args)
  } catch (failure) {
    throw toError(failure)
  }
}

function subscribe<T>(event: string, cb: (payload: T) => void): Unsubscribe {
  const pending = listen<T>(event, (e) => cb(e.payload))
  return () => {
    void pending.then((unlisten) => unlisten())
  }
}

const api: RendererApi = {
  checkAppUpdate: () => call('checkAppUpdate'),
  getAutoDownloadAppUpdates: () => call('getAutoDownloadAppUpdates'),
  setAutoDownloadAppUpdates: (enabled) => call('setAutoDownloadAppUpdates', { enabled }),
  getAppearance: () => call('getAppearance'),
  setTheme: (theme) => call('setTheme', { theme }),
  setFontSize: (fontSize) => call('setFontSize', { fontSize }),
  getAppUpdateState: () => call('getAppUpdateState'),
  downloadAppUpdate: () => call('downloadAppUpdate'),
  restartForAppUpdate: () => call('restartForAppUpdate'),
  onAppUpdateState: (cb) => subscribe(IpcEvent.appUpdateState, cb),
  detectTargets: () => call('detectTargets'),
  install: (request) => call('install', { request }),
  reconcile: (request) => call('reconcile', { request: request ?? null }),
  repair: (request) => call('repair', { request }),
  uninstall: (request) => call('uninstall', { request }),
  getCatalogue: () => call('getCatalogue'),
  refresh: () => call('refresh'),
  getSyncStatus: () => call('getSyncStatus'),
  listRegistries: () => call('listRegistries'),
  addRegistry: (request) => call('addRegistry', { request }),
  updateRegistry: (request) => call('updateRegistry', { request }),
  removeRegistry: (id) => call('removeRegistry', { id }),
  syncRegistry: (id) => call('syncRegistry', { id }),
  listSkillFiles: (request) => call('listSkillFiles', { request }),
  readSkillFile: (request) => call('readSkillFile', { request }),
  showRegistryMenu: (request) => call('showRegistryMenu', { request }),
  onSyncStatus: (cb) => subscribe(IpcEvent.syncStatus, cb),
  onCatalogueUpdated: (cb) => subscribe<void>(IpcEvent.catalogueUpdated, () => cb()),
  onAutoUpdateResult: (cb) => subscribe(IpcEvent.autoUpdateResult, cb),
}

/** The Tauri-backed renderer API. */
export function getApi(): RendererApi {
  return api
}
