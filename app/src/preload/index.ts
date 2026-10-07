import { contextBridge, ipcRenderer } from 'electron'
import { IpcEvent, IpcRequest, type RendererApi, type Unsubscribe } from '../shared/ipc'

function subscribe(channel: string, cb: (payload: unknown) => void): Unsubscribe {
  const listener = (_event: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => {
    ipcRenderer.removeListener(channel, listener as never)
  }
}

const api: RendererApi = {
  checkAppUpdate: () => ipcRenderer.invoke(IpcRequest.checkAppUpdate),
  getAutoDownloadAppUpdates: () => ipcRenderer.invoke(IpcRequest.getAutoDownloadAppUpdates),
  setAutoDownloadAppUpdates: (enabled) =>
    ipcRenderer.invoke(IpcRequest.setAutoDownloadAppUpdates, enabled),
  getAppUpdateState: () => ipcRenderer.invoke(IpcRequest.getAppUpdateState),
  downloadAppUpdate: () => ipcRenderer.invoke(IpcRequest.downloadAppUpdate),
  restartForAppUpdate: () => ipcRenderer.invoke(IpcRequest.restartForAppUpdate),
  onAppUpdateState: (cb) => subscribe(IpcEvent.appUpdateState, (p) => cb(p as never)),
  detectTargets: () => ipcRenderer.invoke(IpcRequest.detectTargets),
  install: (req) => ipcRenderer.invoke(IpcRequest.install, req),
  reconcile: (req) => ipcRenderer.invoke(IpcRequest.reconcile, req),
  repair: (req) => ipcRenderer.invoke(IpcRequest.repair, req),
  uninstall: (req) => ipcRenderer.invoke(IpcRequest.uninstall, req),
  getCatalogue: () => ipcRenderer.invoke(IpcRequest.getCatalogue),
  refresh: () => ipcRenderer.invoke(IpcRequest.refresh),
  getSyncStatus: () => ipcRenderer.invoke(IpcRequest.getSyncStatus),
  listRegistries: () => ipcRenderer.invoke(IpcRequest.listRegistries),
  addRegistry: (req) => ipcRenderer.invoke(IpcRequest.addRegistry, req),
  updateRegistry: (req) => ipcRenderer.invoke(IpcRequest.updateRegistry, req),
  removeRegistry: (id) => ipcRenderer.invoke(IpcRequest.removeRegistry, id),
  syncRegistry: (id) => ipcRenderer.invoke(IpcRequest.syncRegistry, id),
  listSkillFiles: (req) => ipcRenderer.invoke(IpcRequest.listSkillFiles, req),
  readSkillFile: (req) => ipcRenderer.invoke(IpcRequest.readSkillFile, req),
  onSyncStatus: (cb) => subscribe(IpcEvent.syncStatus, (p) => cb(p as never)),
  onCatalogueUpdated: (cb) => subscribe(IpcEvent.catalogueUpdated, () => cb()),
  onAutoUpdateResult: (cb) => subscribe(IpcEvent.autoUpdateResult, (p) => cb(p as never)),
}

if ((process as NodeJS.Process & { contextIsolated?: boolean }).contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as unknown as { api: RendererApi }).api = api
}
