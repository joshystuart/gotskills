import { describe, expect, expectTypeOf, it } from 'vitest'
import { shortSha } from './shortSha'

describe('shortSha', () => {
  it('keeps short values and truncates long values', () => {
    expect(shortSha('abc123')).toBe('abc123')
    expect(shortSha('abc123456789')).toBe('abc1234')
  })

  it('returns undefined for missing values by default', () => {
    expect(shortSha(undefined)).toBeUndefined()
    expect(shortSha(null)).toBeUndefined()
    expect(shortSha('')).toBeUndefined()
    expectTypeOf(shortSha(undefined)).toEqualTypeOf<string | undefined>()
  })

  it('supports a typed null fallback for renderer callers', () => {
    const result = shortSha(undefined, null)

    expect(result).toBeNull()
    expect(shortSha('', null)).toBeNull()
    expectTypeOf(result).toEqualTypeOf<string | null>()
  })
})
