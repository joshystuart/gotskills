import { describe, expect, it, vi } from 'vitest'
import { IpcEvent, type AutoUpdateResult, type RendererApi } from '../shared/ipc'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

vi.mock('electron', () => electron)

describe('auto update IPC contract', () => {
  it('exposes the result subscription through preload and removes its listener on unsubscribe', async () => {
    expect(IpcEvent.autoUpdateResult).toBe('catalogue:autoUpdateResult')
    await import('../preload/index')
    const api = (globalThis as unknown as { api: RendererApi }).api
    const receive = vi.fn()
    const unsubscribe = api.onAutoUpdateResult(receive)
    const result: AutoUpdateResult = {
      registryId: 'r1',
      registryLabel: 'owner/skills',
      updated: [],
      failed: [{ folderName: 'alpha', name: 'Alpha', reason: 'Permission denied' }],
    }
    const [channel, listener] = electron.ipcRenderer.on.mock.calls[0]
    expect(channel).toBe(IpcEvent.autoUpdateResult)
    listener({}, result)
    expect(receive).toHaveBeenCalledWith(result)
    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)
  })
})
