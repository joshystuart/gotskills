import { describe, expect, it } from 'vitest'
import { getAppearance, setAppearance } from './appSettings'
import { openDatabase } from './db/open'

describe('appearance setting', () => {
  it('reads Dark and Default when nothing is stored', () => {
    expect(getAppearance(openDatabase(':memory:'))).toEqual({ theme: 'dark', fontSize: 'default' })
  })

  it.each(['system', 'light', 'dark'] as const)('round-trips the %s theme', (theme) => {
    const db = openDatabase(':memory:')
    setAppearance(db, { theme })
    expect(getAppearance(db)).toEqual({ theme, fontSize: 'default' })
  })

  it.each(['small', 'default', 'large', 'larger'] as const)(
    'round-trips the %s font size',
    (fontSize) => {
      const db = openDatabase(':memory:')
      setAppearance(db, { fontSize })
      expect(getAppearance(db)).toEqual({ theme: 'dark', fontSize })
    }
  )

  it('leaves the other value alone on a partial save', () => {
    const db = openDatabase(':memory:')
    setAppearance(db, { theme: 'light', fontSize: 'large' })
    setAppearance(db, { fontSize: 'small' })
    expect(getAppearance(db)).toEqual({ theme: 'light', fontSize: 'small' })
  })

  it('reads unknown stored values as the defaults', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO app_setting (key, value) VALUES ('theme', 'sepia')").run()
    db.prepare("INSERT INTO app_setting (key, value) VALUES ('font-size', 'huge')").run()
    expect(getAppearance(db)).toEqual({ theme: 'dark', fontSize: 'default' })
  })
})
