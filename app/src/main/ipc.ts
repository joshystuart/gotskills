import type { IpcMain } from 'electron'
import { IpcRequest, type AppApi } from '../shared/ipc'

/**
 * Bridge the typed AppApi seam onto ipcMain. Main owns everything behind these
 * handlers; the renderer only ever sees structured results (never raw stdout).
 */
export function registerIpc(ipcMain: IpcMain, backend: AppApi): void {
  ipcMain.handle(IpcRequest.detectTargets, () => backend.detectTargets())
  ipcMain.handle(IpcRequest.install, (_e, req) => backend.install(req))
  ipcMain.handle(IpcRequest.reconcile, (_e, req) => backend.reconcile(req))
  ipcMain.handle(IpcRequest.repair, (_e, req) => backend.repair(req))
  ipcMain.handle(IpcRequest.uninstall, (_e, req) => backend.uninstall(req))
  ipcMain.handle(IpcRequest.getCatalogue, () => backend.getCatalogue())
  ipcMain.handle(IpcRequest.refresh, () => backend.refresh())
  ipcMain.handle(IpcRequest.getSyncStatus, () => backend.getSyncStatus())
  ipcMain.handle(IpcRequest.listRegistries, () => backend.listRegistries())
  ipcMain.handle(IpcRequest.addRegistry, (_e, req) => backend.addRegistry(req))
  ipcMain.handle(IpcRequest.updateRegistry, (_e, req) => backend.updateRegistry(req))
  ipcMain.handle(IpcRequest.removeRegistry, (_e, id) => backend.removeRegistry(id))
  ipcMain.handle(IpcRequest.syncRegistry, (_e, id) => backend.syncRegistry(id))
  ipcMain.handle(IpcRequest.listSkillFiles, (_e, req) => backend.listSkillFiles(req))
  ipcMain.handle(IpcRequest.readSkillFile, (_e, req) => backend.readSkillFile(req))
}
