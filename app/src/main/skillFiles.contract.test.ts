import { describe, expect, it } from 'vitest'
import { IpcRequest, type AppApi } from '../shared/ipc'
import { registerIpc } from './ipc'

type Handler = (...args: unknown[]) => unknown

function fakeIpcMain(): {
  ipcMain: Parameters<typeof registerIpc>[0]
  handlers: Map<string, Handler>
} {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  } as unknown as Parameters<typeof registerIpc>[0]
  return { ipcMain, handlers }
}

function stubBackend(): { backend: AppApi; calls: string[] } {
  const calls: string[] = []
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name)
      return Promise.resolve(null)
    }
  const backend = {
    detectTargets: record('detectTargets'),
    install: record('install'),
    reconcile: record('reconcile'),
    repair: record('repair'),
    uninstall: record('uninstall'),
    getCatalogue: record('getCatalogue'),
    refresh: record('refresh'),
    getSyncStatus: record('getSyncStatus'),
    listRegistries: record('listRegistries'),
    addRegistry: record('addRegistry'),
    updateRegistry: record('updateRegistry'),
    removeRegistry: record('removeRegistry'),
    syncRegistry: record('syncRegistry'),
    listSkillFiles: record('listSkillFiles'),
    readSkillFile: record('readSkillFile'),
  } as unknown as AppApi
  return { backend, calls }
}

describe('skill file IPC contract', () => {
  it('declares channel names for both methods in the shared constants', () => {
    expect(IpcRequest.listSkillFiles).toBe('api:listSkillFiles')
    expect(IpcRequest.readSkillFile).toBe('api:readSkillFile')
  })

  it('registers main-process handlers that reach the backend for both channels', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const { backend, calls } = stubBackend()
    registerIpc(ipcMain, backend)

    expect(handlers.has(IpcRequest.listSkillFiles)).toBe(true)
    expect(handlers.has(IpcRequest.readSkillFile)).toBe(true)

    const req = { registryId: 'r1', folderName: 'alpha' }
    await handlers.get(IpcRequest.listSkillFiles)!({}, req)
    await handlers.get(IpcRequest.readSkillFile)!({}, { ...req, path: 'SKILL.md' })
    expect(calls).toEqual(['listSkillFiles', 'readSkillFile'])
  })

  it('exposes both methods on the typed AppApi surface (preload passthrough shape)', () => {
    const { backend } = stubBackend()
    expect(typeof backend.listSkillFiles).toBe('function')
    expect(typeof backend.readSkillFile).toBe('function')
  })
})
