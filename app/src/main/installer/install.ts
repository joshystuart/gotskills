import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  InstallationCollisionError,
  skillId as makeSkillId,
  type InstallRequest,
  type InstallResult,
  type InstallTargetId,
  type TargetResult,
} from '../../shared/ipc'
import type { AgentEnvironment } from '../mirror/discovery/agents'
import { SKILLS_CLI_VERSION, type RunSkillsCli, type SkillsCliResult } from './cli'
import { SHARED_CLI_AGENT, SHARED_TARGET, targetCliAgent, targetInstallPath } from './targets'
import { redactError } from './errors'
import { readOccupancy, upsertInstallRecord } from './records'

export const REVISION_REFUSED_MESSAGE =
  'Catalogue changed since you selected this skill. Refresh and re-select to install the current version.'

interface SkillHead {
  head_content_hash: string | null
  head_provenance_sha: string | null
}

export interface InstallDeps {
  db: DatabaseSync
  registryId: string
  mirrorPath: string
  environment: AgentEnvironment
  /** Current mirror HEAD SHA (caller validates under the mirror lock). */
  currentRevision: string
  runSkillsCli: RunSkillsCli
}

function assertNoCollision(deps: InstallDeps, folderName: string, target: InstallTargetId): void {
  const occupant = readOccupancy(deps.db, target, folderName)
  if (occupant && occupant.registryId !== deps.registryId) {
    throw new InstallationCollisionError(
      `"${folderName}" is already installed for ${target} from another registry. Uninstall it first.`,
      'managed',
      folderName,
      target
    )
  }
  if (!occupant && existsSync(targetInstallPath(deps.environment.home, target, folderName))) {
    throw new InstallationCollisionError(
      `"${folderName}" already exists for ${target} outside this app. Remove it first.`,
      'external',
      folderName,
      target
    )
  }
}

function cliArgs(deps: InstallDeps, folderName: string, agent: string): string[] {
  return ['add', deps.mirrorPath, '--skill', folderName, '-g', '-a', agent, '-y', '--copy']
}

async function stageAndCopy(
  deps: InstallDeps,
  folderName: string,
  path: string
): Promise<SkillsCliResult> {
  const stagingHome = mkdtempSync(join(tmpdir(), 'got-skills-stage-'))
  try {
    const cli = await deps.runSkillsCli(cliArgs(deps, folderName, SHARED_CLI_AGENT), {
      home: stagingHome,
    })
    const staged = targetInstallPath(stagingHome, SHARED_TARGET, folderName)
    if (cli.code === 0 && existsSync(staged)) {
      rmSync(path, { recursive: true, force: true })
      cpSync(staged, path, { recursive: true })
    }
    return cli
  } finally {
    rmSync(stagingHome, { recursive: true, force: true })
  }
}

async function installOneTarget(
  deps: InstallDeps,
  folderName: string,
  target: InstallTargetId
): Promise<TargetResult> {
  const { home } = deps.environment
  const agent = targetCliAgent(deps.environment, target)
  const path = targetInstallPath(home, target, folderName)
  const cli = agent
    ? await deps.runSkillsCli(cliArgs(deps, folderName, agent), { home })
    : await stageAndCopy(deps, folderName, path)
  const present = existsSync(path)

  if (cli.code !== 0 || !present) {
    const detail = (cli.stderr || cli.stdout || 'install failed').trim()
    return {
      target,
      outcome: 'failed',
      method: 'copy',
      paths: present ? [path] : [],
      error: redactError(detail || `skills CLI exited ${cli.code}`),
    }
  }

  return { target, outcome: 'installed', method: 'copy', paths: [path] }
}

/**
 * Install a Skill from the local mirror into the requested targets.
 * Caller must hold the mirror lock and supply the current HEAD revision.
 */
export async function installSkill(deps: InstallDeps, req: InstallRequest): Promise<InstallResult> {
  if (req.mirrorRevision !== deps.currentRevision) {
    throw new Error(REVISION_REFUSED_MESSAGE)
  }

  const skill = deps.db
    .prepare(
      `SELECT head_content_hash, head_provenance_sha
       FROM skill WHERE registry_id = ? AND folder_name = ? AND soft_deleted = 0`
    )
    .get(deps.registryId, req.folderName) as SkillHead | undefined

  if (!skill?.head_content_hash || !skill.head_provenance_sha) {
    throw new Error(`Skill "${req.folderName}" is not in the catalogue`)
  }

  for (const target of req.targets) {
    assertNoCollision(deps, req.folderName, target)
  }

  const installedAt = new Date().toISOString()
  const perTarget: TargetResult[] = []

  for (const target of req.targets) {
    const result = await installOneTarget(deps, req.folderName, target)
    perTarget.push(result)

    if (result.outcome === 'installed') {
      upsertInstallRecord(deps.db, {
        registryId: deps.registryId,
        folderName: req.folderName,
        target,
        contentHash: skill.head_content_hash,
        provenanceSha: skill.head_provenance_sha,
        method: result.method,
        paths: result.paths,
        cliVersion: SKILLS_CLI_VERSION,
        installedAt,
      })
    }
  }

  return {
    registryId: deps.registryId,
    folderName: req.folderName,
    skillId: makeSkillId(deps.registryId, req.folderName),
    mirrorRevision: req.mirrorRevision,
    contentHash: skill.head_content_hash,
    provenanceSha: skill.head_provenance_sha,
    cliVersion: SKILLS_CLI_VERSION,
    perTarget,
    installedAt,
  }
}
