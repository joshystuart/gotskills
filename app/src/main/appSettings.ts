import type { DatabaseSync } from 'node:sqlite'
import { FONT_SIZES, THEMES, type FontSize, type Theme } from '../shared/ipc'

function readSetting(db: DatabaseSync, key: string): unknown {
  return db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key)?.value
}

function writeSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function getAutoDownloadAppUpdates(db: DatabaseSync): boolean {
  return readSetting(db, 'app-update-auto-download') !== 'false'
}

export function setAutoDownloadAppUpdates(db: DatabaseSync, enabled: boolean): void {
  writeSetting(db, 'app-update-auto-download', String(enabled))
}

export function getTheme(db: DatabaseSync): Theme {
  const value = readSetting(db, 'theme')
  return THEMES.find((theme) => theme === value) ?? 'dark'
}

export function setTheme(db: DatabaseSync, theme: Theme): void {
  writeSetting(db, 'theme', theme)
}

export function getFontSize(db: DatabaseSync): FontSize {
  const value = readSetting(db, 'font-size')
  return FONT_SIZES.find((size) => size === value) ?? 'default'
}

export function setFontSize(db: DatabaseSync, fontSize: FontSize): void {
  writeSetting(db, 'font-size', fontSize)
}
