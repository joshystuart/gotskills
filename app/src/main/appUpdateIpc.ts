import type { IpcMain } from 'electron'
import { IpcRequest } from '../shared/ipc'
import type { createAppUpdate } from './appUpdate'

export function registerAppUpdateIpc(
  ipcMain: IpcMain,
  appUpdate: ReturnType<typeof createAppUpdate>
): void {
  ipcMain.handle(IpcRequest.checkAppUpdate, () => appUpdate.check())
  ipcMain.handle(IpcRequest.getAutoDownloadAppUpdates, () => appUpdate.getAutoDownload())
  ipcMain.handle(IpcRequest.setAutoDownloadAppUpdates, (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean')
      throw new Error('Automatic download preference must be a boolean')
    appUpdate.setAutoDownload(enabled)
  })
  ipcMain.handle(IpcRequest.getAppUpdateState, () => appUpdate.getState())
  ipcMain.handle(IpcRequest.downloadAppUpdate, () => appUpdate.download())
  ipcMain.handle(IpcRequest.restartForAppUpdate, () => appUpdate.restart())
}
