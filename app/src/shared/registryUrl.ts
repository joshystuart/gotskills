export class RegistryUrlError extends Error {
  readonly code = 'registry-url-invalid' as const
  constructor(message: string) {
    super(message)
    this.name = 'RegistryUrlError'
  }
}

export interface CanonicalRegistry {
  /** Normalized URL safe to persist and clone (credentials already rejected). */
  url: string
  /** Unique dedup key: `github:owner/repo` (lowercased) or `git:<normalized>`. */
  canonicalKey: string
  githubOwner: string | null
  githubRepo: string | null
  /** Display label: `owner/repo` for GitHub, else host/path or the raw URL. */
  label: string
  isGitHub: boolean
}

const SCP_LIKE = /^([^@\s]+)@([^:/\s]+):(.+)$/

function stripRepoSuffix(segment: string): string {
  return segment.replace(/\.git$/i, '')
}

function toOwnerRepo(pathname: string): { owner: string; repo: string } | null {
  const parts = pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (parts.length !== 2) return null
  const owner = parts[0]
  const repo = stripRepoSuffix(parts[1])
  if (!owner || !repo) return null
  return { owner, repo }
}

function githubResult(owner: string, repo: string, url: string): CanonicalRegistry {
  return {
    url,
    canonicalKey: `github:${owner.toLowerCase()}/${repo.toLowerCase()}`,
    githubOwner: owner,
    githubRepo: repo,
    label: `${owner}/${repo}`,
    isGitHub: true,
  }
}

function genericResult(url: string, canonicalBody: string, label: string): CanonicalRegistry {
  return {
    url,
    canonicalKey: `git:${canonicalBody}`,
    githubOwner: null,
    githubRepo: null,
    label,
    isGitHub: false,
  }
}

/**
 * Validate + canonicalize a Registry Git URL (ADR 0001).
 * A GitHub owner/repository maps to at most one Registry, whose branch is
 * editable. Non-GitHub public Git URLs are preserved as-is.
 * Throws RegistryUrlError (never leaking credential material) on rejection.
 */
export function canonicalizeRegistryUrl(input: string): CanonicalRegistry {
  const url = input.trim()
  if (!url) {
    throw new RegistryUrlError('Registry URL is required')
  }

  const scp = SCP_LIKE.exec(url)
  if (scp && !url.includes('://')) {
    const [, user, host, path] = scp
    if (user.includes(':')) {
      throw new RegistryUrlError('Registry URL must not contain embedded credentials')
    }
    if (host.toLowerCase() === 'github.com') {
      const ownerRepo = toOwnerRepo(path)
      if (!ownerRepo) {
        throw new RegistryUrlError('GitHub registry URL must be a bare owner/repo')
      }
      return githubResult(ownerRepo.owner, ownerRepo.repo, url)
    }
    const canonicalBody = `${host}/${stripRepoSuffix(path.replace(/\/+$/g, ''))}`
    return genericResult(url, canonicalBody, canonicalBody)
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    if (url.startsWith('/') || url.startsWith('file:')) {
      const body = stripRepoSuffix(url.replace(/\/+$/g, ''))
      return genericResult(url, body, url)
    }
    throw new RegistryUrlError('Registry URL is not a valid Git URL')
  }

  if (parsed.password) {
    throw new RegistryUrlError('Registry URL must not contain embedded credentials')
  }
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  if (parsed.username && isHttp) {
    throw new RegistryUrlError('Registry URL must not contain embedded credentials')
  }

  if (parsed.hostname.toLowerCase() === 'github.com') {
    const ownerRepo = toOwnerRepo(parsed.pathname)
    if (!ownerRepo) {
      throw new RegistryUrlError('GitHub registry URL must be a bare owner/repo')
    }
    return githubResult(ownerRepo.owner, ownerRepo.repo, url)
  }

  const normalizedPath = stripRepoSuffix(parsed.pathname.replace(/\/+$/g, ''))
  const canonicalBody = `${parsed.protocol}//${parsed.host.toLowerCase()}${normalizedPath}`
  const label = `${parsed.host}${normalizedPath}`
  return genericResult(url, canonicalBody, label)
}
