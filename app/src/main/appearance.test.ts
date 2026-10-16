import { describe, expect, it } from 'vitest'
import { getAppearance, setAppearance } from './appSettings'
import { openDatabase } from './db/open'
import { createAppearanceController } from './appearance'

function fakeNativeTheme(): { themeSource: string; shouldUseDarkColors: boolean } {
  const state = { source: 'system' }
  return {
    get themeSource() {
      return state.source
    },
    set themeSource(value: string) {
      state.source = value
    },
    get shouldUseDarkColors() {
      return state.source !== 'light'
    },
  }
}

function controller(stored?: string) {
  const db = openDatabase(':memory:')
  if (stored) db.prepare("INSERT INTO app_setting (key, value) VALUES ('theme', ?)").run(stored)
  const nativeTheme = fakeNativeTheme()
  const appearance = createAppearanceController({
    nativeTheme,
    store: {
      getAppearance: () => getAppearance(db),
      setAppearance: (value) => setAppearance(db, value),
    },
  })
  return { db, nativeTheme, appearance }
}

describe('appearance controller', () => {
  it('applies the stored theme as the native theme source', () => {
    const { nativeTheme, appearance } = controller('light')
    appearance.apply()
    expect(nativeTheme.themeSource).toBe('light')
    expect(appearance.backgroundColor()).toBe('#ffffff')
  })

  it.each([undefined, 'sepia'])('applies dark when the stored theme is %s', (stored) => {
    const { nativeTheme, appearance } = controller(stored)
    appearance.apply()
    expect(nativeTheme.themeSource).toBe('dark')
    expect(appearance.backgroundColor()).toBe('#09090b')
  })

  it('saves a new theme and applies it at once', () => {
    const { db, nativeTheme, appearance } = controller()
    appearance.setTheme('system')
    expect(nativeTheme.themeSource).toBe('system')
    expect(getAppearance(db).theme).toBe('system')
    expect(appearance.get()).toEqual({ theme: 'system', fontSize: 'default' })
  })

  it('saves a new font size and reports it', () => {
    const { db, appearance } = controller()
    appearance.setFontSize('large')
    expect(getAppearance(db).fontSize).toBe('large')
    expect(appearance.get()).toEqual({ theme: 'dark', fontSize: 'large' })
  })

  it('rejects an unknown font size without saving it', () => {
    const { db, appearance } = controller()
    expect(() => appearance.setFontSize('huge' as never)).toThrow(
      'Font size must be small, default, large or larger'
    )
    expect(getAppearance(db).fontSize).toBe('default')
  })

  it('rejects an unknown theme without saving it', () => {
    const { db, appearance } = controller()
    expect(() => appearance.setTheme('sepia' as never)).toThrow(
      'Theme must be system, light or dark'
    )
    expect(getAppearance(db).theme).toBe('dark')
  })
})
