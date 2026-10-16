import type { DatabaseSync } from 'node:sqlite'
import { FONT_SIZES, THEMES, type Appearance } from '../shared/ipc'

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

export function getAppearance(db: DatabaseSync): Appearance {
  const theme = readSetting(db, 'theme')
  const fontSize = readSetting(db, 'font-size')
  return {
    theme: THEMES.find((value) => value === theme) ?? 'dark',
    fontSize: FONT_SIZES.find((value) => value === fontSize) ?? 'default',
  }
}

export function setAppearance(db: DatabaseSync, appearance: Partial<Appearance>): void {
  if (appearance.theme) writeSetting(db, 'theme', appearance.theme)
  if (appearance.fontSize) writeSetting(db, 'font-size', appearance.fontSize)
}
