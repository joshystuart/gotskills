import { autoUpdater } from 'electron-updater'
import { createAppUpdate } from './appUpdate'
import { registerAppUpdateIpc } from './appUpdateIpc'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { createBackend } from './backend'
import { isGitAvailable } from './mirror/git'
import { IpcEvent } from '../shared/ipc'
import { registerRendererProtocol, rendererEntryUrl } from './rendererProtocol'

function devAppIcon(): string | undefined {
  const iconPath = join(__dirname, '../../build/icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1000,
    minHeight: 560,
    show: false,
    backgroundColor: '#0e1015',
    icon: devAppIcon(),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadURL(rendererEntryUrl())
  }

  return win
}

async function gateOnGit(): Promise<boolean> {
  if (isGitAvailable()) return true
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Git required',
    message: 'Got Skills needs Git to sync the skill registry.',
    detail:
      'Install the Xcode Command Line Tools (xcode-select --install) or Git, then relaunch the app.',
    buttons: ['Quit'],
    defaultId: 0,
  })
  return false
}

app.whenReady().then(async () => {
  if (!(await gateOnGit())) {
    app.quit()
    return
  }

  if (!process.env['ELECTRON_RENDERER_URL']) {
    registerRendererProtocol(join(__dirname, '../renderer'))
  }

  let win: BrowserWindow | null = null

  const backend = createBackend({
    paths: { userData: app.getPath('userData') },
    onSyncStatus: (status) => {
      win?.webContents.send(IpcEvent.syncStatus, status)
    },
    onAutoUpdateResult: (result) => {
      win?.webContents.send(IpcEvent.autoUpdateResult, result)
    },
    onCatalogueUpdated: () => {
      win?.webContents.send(IpcEvent.catalogueUpdated)
    },
    onBusyChange: () => appUpdate.busyChanged(),
  })
  const appUpdate = createAppUpdate({
    updater: autoUpdater,
    getAutoDownload: backend.getAutoDownloadAppUpdates,
    setAutoDownload: backend.setAutoDownloadAppUpdates,
    isBusy: backend.isBusy,
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    onState: (state) => win?.webContents.send(IpcEvent.appUpdateState, state),
    log: (error) => console.error('App Update:', error),
  })
  registerAppUpdateIpc(ipcMain, appUpdate)
  registerIpc(ipcMain, backend)

  win = createWindow()

  win.webContents.on('did-finish-load', () => {
    void (async () => {
      win?.webContents.send(IpcEvent.syncStatus, await backend.getSyncStatus())
      await backend.syncNow()
    })()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow()
    }
  })

  app.on('before-quit', () => {
    appUpdate.close()
    backend.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
