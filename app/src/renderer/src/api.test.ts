import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallationCollisionError } from '../../shared/ipc'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

const { getApi } = await import('./api')

describe('getApi', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
  })

  it('invokes the snake_case command with a request argument', async () => {
    invoke.mockResolvedValue({ ok: true })
    const request = { registryId: 'r', folderName: 'f', targets: [], mirrorRevision: 'x' }
    await getApi().install(request)
    expect(invoke).toHaveBeenCalledWith('install', { request })
    await getApi().getCatalogue()
    expect(invoke).toHaveBeenLastCalledWith('get_catalogue', undefined)
    await getApi().setFontSize('large')
    expect(invoke).toHaveBeenLastCalledWith('set_font_size', { fontSize: 'large' })
  })

  it('rebuilds an installation collision error', async () => {
    invoke.mockRejectedValue({
      kind: 'installation-collision',
      message: 'taken',
      occupant: 'managed',
      folderName: 'f',
      target: 't',
    })
    const error = await getApi()
      .uninstall({ registryId: 'r', folderName: 'f', targets: [] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InstallationCollisionError)
    expect(error).toMatchObject({ occupant: 'managed', folderName: 'f', target: 't' })
  })

  it('wraps other failures in Error', async () => {
    invoke.mockRejectedValue({ kind: 'io', message: 'disk' })
    await expect(getApi().refresh()).rejects.toThrow('disk')
  })

  it('subscribes to events and unsubscribes', async () => {
    const unlisten = vi.fn()
    let handler: (e: { payload: unknown }) => void = () => {}
    listen.mockImplementation((_name, cb) => {
      handler = cb
      return Promise.resolve(unlisten)
    })
    const seen = vi.fn()
    const off = getApi().onSyncStatus(seen)
    expect(listen).toHaveBeenCalledWith('sync:status', expect.any(Function))
    handler({ payload: { phase: 'synced' } })
    expect(seen).toHaveBeenCalledWith({ phase: 'synced' })
    off()
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })
})
