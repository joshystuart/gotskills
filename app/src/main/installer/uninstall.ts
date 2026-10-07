import { existsSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  skillId as makeSkillId,
  type UninstallRequest,
  type UninstallResult,
} from '../../shared/ipc'
import { targetInstallPath } from './targets'
import { redactError } from './errors'
import { deleteInstallRecord } from './records'

export interface UninstallDeps {
  db: DatabaseSync
  home: string
}

export async function uninstallSkill(
  deps: UninstallDeps,
  req: UninstallRequest
): Promise<UninstallResult> {
  const perTarget: UninstallResult['perTarget'] = []

  for (const target of req.targets) {
    const path = targetInstallPath(deps.home, target, req.folderName)
    const existed = existsSync(path)
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      perTarget.push({ target, outcome: 'failed', paths: [], error: redactError(message) })
      continue
    }

    deleteInstallRecord(deps.db, target, req.folderName)
    perTarget.push({ target, outcome: 'installed', paths: existed ? [path] : [] })
  }

  return {
    registryId: req.registryId,
    folderName: req.folderName,
    skillId: makeSkillId(req.registryId, req.folderName),
    perTarget,
  }
}
