import { describe, expect, it } from 'vitest'
import { classifyGitError, redactGitError } from './gitErrors'

describe('classifyGitError', () => {
  it.each([
    'fatal: Authentication failed for "https://github.com/org/repo"',
    'could not read Username for https://github.com',
    'remote: Repository not found.',
    'fatal: repository not found',
    'terminal prompts disabled',
    'The requested URL returned error: 403',
    'The requested URL returned error: 401',
  ])('maps GitHub access ambiguity to access-required: %s', (message) => {
    expect(classifyGitError(message)).toBe('access-required')
  })

  it.each([
    'fatal: unable to access: Could not resolve host: github.com',
    'ssh: connect to host github.com port 22: Operation timed out',
    'fatal: unable to access: Failed to connect',
  ])('maps connectivity failures to offline: %s', (message) => {
    expect(classifyGitError(message)).toBe('offline')
  })
})

describe('redactGitError', () => {
  it('strips embedded credentials from a remote URL', () => {
    const redacted = redactGitError(
      'fatal: unable to access https://x-access-token:ghp_secret@github.com/org/repo.git/'
    )
    expect(redacted).not.toMatch(/ghp_secret/)
    expect(redacted).not.toMatch(/x-access-token/)
  })

  it('redacts absolute user paths', () => {
    expect(redactGitError('error at /Users/someone/secret/mirror')).not.toMatch(/someone/)
  })

  it('bounds the message length', () => {
    expect(redactGitError('x'.repeat(1000)).length).toBeLessThanOrEqual(280)
  })
})
