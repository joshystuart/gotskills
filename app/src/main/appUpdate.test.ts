import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdate } from './appUpdate'

function setup(packaged = true, autoDownload = true, isBusy = () => false) {
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
  })
  const onState = vi.fn()
  const log = vi.fn()
  const service = createAppUpdate({
    updater,
    packaged,
    currentVersion: '0.0.6',
    onState,
    log,
    getAutoDownload: () => autoDownload,
    setAutoDownload: vi.fn(),
    isBusy,
  })
  return { updater, onState, log, service }
}

function ready(overrides: { waiting?: boolean } = {}) {
  return { kind: 'ready', currentVersion: '0.0.6', version: '0.0.7', waiting: false, ...overrides }
}

afterEach(() => vi.useRealTimers())

describe('App Update', () => {
  it('checks at launch and every four hours', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.close()
  })
  it('waits for a download request when automatic downloads are off', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup(true, false)
    updater.emit('update-available', { version: '0.0.7' })
    expect(service.getState()).toEqual({
      kind: 'available',
      currentVersion: '0.0.6',
      version: '0.0.7',
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    await service.download()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    service.close()
  })

  it('reports an up-to-date result after a manual check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    const { updater, service } = setup()
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available')
    })
    await service.check()
    expect(service.getState()).toEqual({
      kind: 'idle',
      currentVersion: '0.0.6',
      lastCheck: { at: '2026-10-06T00:00:00.000Z', result: 'up-to-date' },
    })
    service.close()
  })

  it('reports manual check errors next to the current version', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup()
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockRejectedValueOnce(new Error('Offline'))
    await service.check()
    expect(service.getState()).toEqual({
      kind: 'idle',
      currentVersion: '0.0.6',
      lastCheck: { at: expect.any(String), result: 'error', message: 'Offline' },
    })
    service.close()
  })

  it('downloads a new release and publishes progress and ready states', async () => {
    vi.useFakeTimers()
    const { updater, onState, service } = setup()
    updater.emit('update-available', { version: '0.0.7' })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    updater.emit('download-progress', { percent: 42 })
    expect(onState).toHaveBeenLastCalledWith({
      kind: 'downloading',
      currentVersion: '0.0.6',
      version: '0.0.7',
      percent: 42,
    })
    updater.emit('update-downloaded', { version: '0.0.7' })
    expect(service.getState()).toEqual(ready())
    service.close()
  })

  it('marks the ready release as waiting when the download finishes while busy', () => {
    vi.useFakeTimers()
    const { updater, onState, service } = setup(true, true, () => true)
    updater.emit('update-available', { version: '0.0.7' })
    updater.emit('update-downloaded', { version: '0.0.7' })
    expect(onState).toHaveBeenLastCalledWith(ready({ waiting: true }))
    service.close()
  })

  it('republishes the ready release as no longer waiting once busy work finishes', () => {
    vi.useFakeTimers()
    let busy = true
    const { updater, onState, service } = setup(true, true, () => busy)
    updater.emit('update-available', { version: '0.0.7' })
    updater.emit('update-downloaded', { version: '0.0.7' })
    busy = false
    service.busyChanged()
    expect(onState).toHaveBeenLastCalledWith(ready())
    service.close()
  })

  it('publishes nothing when busy work changes without changing whether the restart waits', () => {
    vi.useFakeTimers()
    const { updater, onState, service } = setup(true, true, () => true)
    updater.emit('update-available', { version: '0.0.7' })
    updater.emit('update-downloaded', { version: '0.0.7' })
    onState.mockClear()
    service.busyChanged()
    expect(onState).not.toHaveBeenCalled()
    service.close()
  })

  it('publishes nothing when busy work changes before a release is ready', () => {
    vi.useFakeTimers()
    let busy = true
    const { updater, onState, service } = setup(true, true, () => busy)
    updater.emit('update-available', { version: '0.0.7' })
    onState.mockClear()
    busy = false
    service.busyChanged()
    expect(onState).not.toHaveBeenCalled()
    service.close()
  })

  it('installs on quit and restarts only after the download is ready', () => {
    vi.useFakeTimers()
    const { updater, service } = setup()
    service.restart()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.autoInstallOnAppQuit).toBe(true)
    updater.emit('update-available', { version: '0.0.7' })
    updater.emit('update-downloaded', { version: '0.0.7' })
    service.restart()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    service.close()
  })
  it('keeps background failures quiet and retries at the next interval', async () => {
    vi.useFakeTimers()
    const { updater, service, onState, log } = setup()
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockRejectedValueOnce(new Error('Offline'))
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(service.getState()).toEqual({ kind: 'idle', currentVersion: '0.0.6' })
    expect(onState).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(new Error('Offline'))
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)
    service.close()
  })
  it('keeps checking for newer releases while one waits to be downloaded', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup(true, false)
    updater.emit('update-available', { version: '0.0.7' })
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.0.8' })
    })
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(service.getState()).toEqual({
      kind: 'available',
      currentVersion: '0.0.6',
      version: '0.0.8',
    })
    service.close()
  })

  it('runs a manual check while a release waits to be downloaded', async () => {
    vi.useFakeTimers()
    const { updater, onState, service } = setup(true, false)
    updater.emit('update-available', { version: '0.0.7' })
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.0.8' })
    })
    await service.check()
    expect(onState).toHaveBeenCalledWith({ kind: 'checking', currentVersion: '0.0.6' })
    expect(service.getState()).toEqual({
      kind: 'available',
      currentVersion: '0.0.6',
      version: '0.0.8',
    })
    service.close()
  })

  it('keeps the waiting release when a manual check fails', async () => {
    vi.useFakeTimers()
    const { updater, log, service } = setup(true, false)
    updater.emit('update-available', { version: '0.0.7' })
    await vi.advanceTimersByTimeAsync(0)
    updater.checkForUpdates.mockRejectedValueOnce(new Error('Offline'))
    await service.check()
    expect(service.getState()).toEqual({
      kind: 'available',
      currentVersion: '0.0.6',
      version: '0.0.7',
    })
    expect(log).toHaveBeenCalledWith(new Error('Offline'))
    service.close()
  })

  it('does not check while a release downloads or waits to install', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup()
    await vi.advanceTimersByTimeAsync(0)
    updater.emit('update-available', { version: '0.0.7' })
    await service.check()
    updater.emit('update-downloaded', { version: '0.0.7' })
    await service.check()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    service.close()
  })

  it('does not offer pre-releases', () => {
    vi.useFakeTimers()
    const { updater, service, onState } = setup()
    expect(updater.allowPrerelease).toBe(false)
    updater.emit('update-available', { version: '0.0.7-beta.1' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(onState).not.toHaveBeenCalled()
    service.close()
  })
  it('never invokes or configures the updater in an unpackaged app', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup(false)
    await service.download()
    service.restart()
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.eventNames()).toEqual([])
    expect(updater.autoInstallOnAppQuit).toBe(false)
    service.close()
  })
  it('reports download failures and downloads again on retry', async () => {
    vi.useFakeTimers()
    const { updater, service } = setup()
    updater.downloadUpdate.mockRejectedValueOnce(new Error('Connection lost'))
    updater.emit('update-available', { version: '0.0.7' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getState()).toEqual({
      kind: 'download-failed',
      currentVersion: '0.0.6',
      version: '0.0.7',
      message: 'Connection lost',
    })
    await service.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(service.getState().kind).toBe('downloading')
    service.close()
  })
})

it('reports a manual check even when the launch check is still running', async () => {
  vi.useFakeTimers()
  let finish: (() => void) | undefined
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    ),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
  })
  const service = createAppUpdate({
    updater,
    packaged: true,
    currentVersion: '0.0.6',
    onState: vi.fn(),
    log: vi.fn(),
    getAutoDownload: () => true,
    setAutoDownload: vi.fn(),
    isBusy: () => false,
  })
  await service.check()
  expect(service.getState().kind).toBe('checking')
  finish?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(service.getState()).toEqual({
    kind: 'idle',
    currentVersion: '0.0.6',
    lastCheck: { at: expect.any(String), result: 'up-to-date' },
  })
  service.close()
})

it('ignores restart while an operation runs, then allows it after completion', () => {
  vi.useFakeTimers()
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
  })
  let busy = true
  const service = createAppUpdate({
    updater,
    packaged: true,
    currentVersion: '0.0.6',
    onState: vi.fn(),
    log: vi.fn(),
    getAutoDownload: () => true,
    setAutoDownload: vi.fn(),
    isBusy: () => busy,
  })
  updater.emit('update-available', { version: '0.0.7' })
  updater.emit('update-downloaded', { version: '0.0.7' })
  service.restart()
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  expect(updater.autoInstallOnAppQuit).toBe(true)
  busy = false
  service.restart()
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  service.close()
})
