import type { RegistryConfig } from '../shared/ipc'

export type { RegistryConfig }

export const DEFAULT_REGISTRY: RegistryConfig = {
  url: 'https://github.com/anthropics/skills',
  branch: 'main',
}
