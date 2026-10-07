import { describe, expect, it } from 'vitest'
import { redactError } from './errors'

describe('redactError', () => {
  it('redacts supported home and temporary paths', () => {
    expect(
      redactError(
        'failed /Users/alice/project/file.ts:12 /home/bob/private.txt /var/folders/xy/secret/item'
      )
    ).toBe('failed ~:12 ~ ~')
  })

  it('limits the redacted message to 280 characters', () => {
    expect(redactError('x'.repeat(300))).toBe('x'.repeat(280))
  })
})
