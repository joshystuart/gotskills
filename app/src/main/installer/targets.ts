import { isAbsolute, join, relative } from 'node:path'
import type { InstallTargetId, InstallTargetStatus, SupportedAgent } from '../../shared/ipc'
import { agentTable, type Agent, type AgentEnvironment } from '../mirror/discovery/agents'

export const SHARED_TARGET: InstallTargetId = '~/.agents/skills'

export const SHARED_CLI_AGENT = 'universal'

export function targetFolder(home: string, target: InstallTargetId): string {
  return target.startsWith('~/') ? join(home, target.slice(2)) : target
}

export function targetIdForFolder(home: string, folder: string): InstallTargetId {
  const fromHome = relative(home, folder)
  const underHome = fromHome !== '' && !fromHome.startsWith('..') && !isAbsolute(fromHome)
  return underHome ? `~/${fromHome}` : folder
}

export function targetInstallPath(
  home: string,
  target: InstallTargetId,
  folderName: string
): string {
  return join(targetFolder(home, target), folderName)
}

export function targetCliAgent(
  environment: AgentEnvironment,
  target: InstallTargetId
): string | undefined {
  if (target === SHARED_TARGET) return SHARED_CLI_AGENT
  return agentTable(environment).find(
    (agent) => targetIdForFolder(environment.home, agent.installFolder) === target
  )?.id
}

function targetNames(id: InstallTargetId, served: Agent[], native: Agent[]): string[] {
  const detected = served.filter((agent) => agent.detected)
  if (id === SHARED_TARGET && detected.length === 0) return ['Shared folder']
  const named = id === SHARED_TARGET ? detected : served.length > 0 ? served : native
  return named.length > 0 ? named.map((agent) => agent.displayName) : [id]
}

export function detectInstallTargets(
  environment: AgentEnvironment,
  recordTargets: Iterable<InstallTargetId>
): InstallTargetStatus[] {
  const { home } = environment
  const withRecords = new Set(recordTargets)
  const table = agentTable(environment)
  const served = new Map<InstallTargetId, Agent[]>()
  for (const agent of table) {
    const id = targetIdForFolder(home, agent.installFolder)
    served.set(id, [...(served.get(id) ?? []), agent])
  }
  const ids = [
    ...[...served.keys()].filter((id) => id !== SHARED_TARGET),
    SHARED_TARGET,
    ...[...withRecords].filter((id) => !served.has(id) && id !== SHARED_TARGET),
  ]
  return ids.map((id) => {
    const targetAgents = served.get(id) ?? []
    const names = targetNames(
      id,
      targetAgents,
      table.filter((agent) => targetIdForFolder(home, agent.nativeFolder) === id)
    )
    return {
      id,
      label: names.join(', '),
      shared: id === SHARED_TARGET,
      visible: withRecords.has(id) || targetAgents.some((agent) => agent.detected),
      agents: targetAgents.map(({ id, displayName, detected }) => ({ id, displayName, detected })),
    }
  })
}

export function supportedAgents(environment: AgentEnvironment): SupportedAgent[] {
  return agentTable(environment).map(({ id, displayName, installFolder, detected }) => ({
    id,
    displayName,
    target: targetIdForFolder(environment.home, installFolder),
    detected,
  }))
}

export function telemetryTargets(
  environment: AgentEnvironment,
  recordTargets: Iterable<InstallTargetId>
): Set<InstallTargetId> {
  return new Set(
    detectInstallTargets(environment, recordTargets)
      .map((target) => target.id)
      .filter((id) => id.startsWith('~/'))
  )
}
