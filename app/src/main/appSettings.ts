import type { DatabaseSync } from 'node:sqlite'
import { THEMES, type Theme } from '../shared/ipc'

export function getAutoDownloadAppUpdates(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT value FROM app_setting WHERE key = ?')
    .get('app-update-auto-download')
  return row?.value !== 'false'
}

export function setAutoDownloadAppUpdates(db: DatabaseSync, enabled: boolean): void {
  db.prepare(
    'INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('app-update-auto-download', String(enabled))
}

export function getTheme(db: DatabaseSync): Theme {
  const value = db.prepare('SELECT value FROM app_setting WHERE key = ?').get('theme')?.value
  return THEMES.find((theme) => theme === value) ?? 'dark'
}

export function setTheme(db: DatabaseSync, theme: Theme): void {
  db.prepare(
    'INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('theme', theme)
}
