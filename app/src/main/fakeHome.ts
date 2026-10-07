import { existsSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { AgentEnvironment } from './mirror/discovery/agents'

export function fakeHomeEnvironment(home: string): AgentEnvironment {
  const insideHome = (path: string) => {
    const fromHome = relative(home, path)
    return !fromHome.startsWith('..') && !isAbsolute(fromHome)
  }
  return { home, env: {}, exists: (path) => insideHome(path) && existsSync(path) }
}

export function fakeHomeDetection(home: string): Pick<AgentEnvironment, 'env' | 'exists'> {
  const { env, exists } = fakeHomeEnvironment(home)
  return { env, exists }
}
