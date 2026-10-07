import { describe, expect, it } from 'vitest'
import { RegistryUrlError, canonicalizeRegistryUrl } from './registryUrl'

describe('canonicalizeRegistryUrl', () => {
  describe('credential rejection', () => {
    it.each([
      'https://user:pass@github.com/anthropics/skills',
      'https://ghp_token123@github.com/anthropics/skills',
      'https://x-access-token:secret@example.com/team/skills.git',
      'ssh://git:hunter2@github.com/anthropics/skills',
    ])('rejects embedded credentials in %s', (url) => {
      expect(() => canonicalizeRegistryUrl(url)).toThrow(RegistryUrlError)
    })

    it('does not leak the credential material in the thrown message', () => {
      try {
        canonicalizeRegistryUrl('https://x-access-token:supersecret@example.com/team/skills.git')
        throw new Error('expected rejection')
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryUrlError)
        expect((err as Error).message).not.toMatch(/supersecret/)
      }
    })

    it('rejects blank input', () => {
      expect(() => canonicalizeRegistryUrl('   ')).toThrow(RegistryUrlError)
    })
  })

  describe('GitHub canonicalization', () => {
    it.each([
      ['https://github.com/anthropics/skills', 'anthropics', 'skills'],
      ['https://github.com/anthropics/skills.git', 'anthropics', 'skills'],
      ['https://github.com/anthropics/skills/', 'anthropics', 'skills'],
      ['git@github.com:anthropics/skills.git', 'anthropics', 'skills'],
      ['ssh://git@github.com/anthropics/skills.git', 'anthropics', 'skills'],
      ['https://GitHub.com/Anthropics/Skills', 'Anthropics', 'Skills'],
    ])('maps %s to owner/repo', (url, owner, repo) => {
      const result = canonicalizeRegistryUrl(url)
      expect(result.githubOwner).toBe(owner)
      expect(result.githubRepo).toBe(repo)
      expect(result.isGitHub).toBe(true)
    })

    it('uses a case-insensitive canonical key so one owner/repo maps to one Registry', () => {
      const a = canonicalizeRegistryUrl('https://github.com/anthropics/skills')
      const b = canonicalizeRegistryUrl('git@github.com:Anthropics/Skills.git')
      expect(a.canonicalKey).toBe('github:anthropics/skills')
      expect(b.canonicalKey).toBe(a.canonicalKey)
    })

    it('rejects a GitHub URL that is not a bare owner/repo', () => {
      expect(() =>
        canonicalizeRegistryUrl('https://github.com/anthropics/skills/tree/main')
      ).toThrow(RegistryUrlError)
      expect(() => canonicalizeRegistryUrl('https://github.com/anthropics')).toThrow(
        RegistryUrlError
      )
    })

    it('labels GitHub registries as owner/repo', () => {
      expect(canonicalizeRegistryUrl('https://github.com/anthropics/skills').label).toBe(
        'anthropics/skills'
      )
    })
  })

  describe('generic public Git URLs', () => {
    it('preserves a non-GitHub HTTPS URL without inventing GitHub fields', () => {
      const result = canonicalizeRegistryUrl('https://git.example.com/team/skills.git')
      expect(result.isGitHub).toBe(false)
      expect(result.githubOwner).toBeNull()
      expect(result.githubRepo).toBeNull()
      expect(result.url).toBe('https://git.example.com/team/skills.git')
      expect(result.canonicalKey).toBe('git:https://git.example.com/team/skills')
    })

    it('canonicalizes distinct spellings of the same non-GitHub remote together', () => {
      const a = canonicalizeRegistryUrl('https://git.example.com/team/skills.git')
      const b = canonicalizeRegistryUrl('https://git.example.com/team/skills/')
      expect(a.canonicalKey).toBe(b.canonicalKey)
    })

    it('accepts a local file path registry', () => {
      const result = canonicalizeRegistryUrl('/tmp/local-registry')
      expect(result.isGitHub).toBe(false)
      expect(result.url).toBe('/tmp/local-registry')
    })
  })
})
