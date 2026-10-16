import { describe, expect, it } from 'vitest'
import { getTheme, setTheme } from './appSettings'
import { openDatabase } from './db/open'

describe('theme setting', () => {
  it('reads as dark with nothing stored', () => {
    expect(getTheme(openDatabase(':memory:'))).toBe('dark')
  })

  it('round-trips each stored theme', () => {
    const db = openDatabase(':memory:')
    for (const theme of ['light', 'system', 'dark'] as const) {
      setTheme(db, theme)
      expect(getTheme(db)).toBe(theme)
    }
  })

  it('reads an unknown stored value as dark', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO app_setting (key, value) VALUES ('theme', 'sepia')").run()
    expect(getTheme(db)).toBe('dark')
  })
})
