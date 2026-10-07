import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend } from './backend'
import { fakeHomeDetection } from './fakeHome'

describe('backend sync status API consistency', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the same aggregate status from getSyncStatus and getCatalogue', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-status-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-status-home-'))
    dirs.push(userData, home)

    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: async () => ({ code: 0, stdout: '', stderr: '' }),
    })

    for (const r of await backend.listRegistries()) {
      await backend.removeRegistry(r.id)
    }

    await backend.addRegistry({
      url: join(userData, 'no-such-remote'),
      branch: 'main',
    })

    const statusApi = await backend.getSyncStatus()
    const catalogue = await backend.getCatalogue()

    expect(statusApi.phase).toBe('failed')
    expect(statusApi.reason).toBe('offline')
    expect(catalogue.syncStatus).toEqual(statusApi)
    backend.close()
  })
})
