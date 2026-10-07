import {
  cpSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { InstallRecord } from '../../shared/ipc'
import { SHARED_TARGET, targetInstallPath } from './targets'
import { readInstallRecords, readOccupancy, upsertInstallRecord } from './records'

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function resolvesTo(link: string, target: string): boolean {
  try {
    return realpathSync(link) === realpathSync(target)
  } catch {
    return false
  }
}

function replaceLinkWithCopy(link: string): void {
  const staging = `${link}.gotskills-copy`
  if (isSymlink(link)) {
    rmSync(staging, { recursive: true, force: true })
    cpSync(realpathSync(link), staging, { recursive: true })
    unlinkSync(link)
  }
  if (!existsSync(link) && existsSync(staging)) renameSync(staging, link)
}

function convertOwnFolder(db: DatabaseSync, home: string, record: InstallRecord): void {
  const own = targetInstallPath(home, record.target, record.folderName)
  const shared = targetInstallPath(home, SHARED_TARGET, record.folderName)
  if (resolvesTo(own, shared) && !readOccupancy(db, SHARED_TARGET, record.folderName)) {
    upsertInstallRecord(db, { ...record, target: SHARED_TARGET, method: 'copy', paths: [shared] })
  }
  replaceLinkWithCopy(own)
  upsertInstallRecord(db, { ...record, method: 'copy', paths: [own] })
}

function convertShared(db: DatabaseSync, home: string, record: InstallRecord): void {
  const oldLink = join(home, '.cursor', 'skills', record.folderName)
  const shared = targetInstallPath(home, SHARED_TARGET, record.folderName)
  if (isSymlink(oldLink) && resolvesTo(oldLink, shared)) unlinkSync(oldLink)
  upsertInstallRecord(db, { ...record, method: 'copy', paths: [shared] })
}

export function convertSymlinkInstalls(db: DatabaseSync, home: string): void {
  for (const record of readInstallRecords(db)) {
    if (record.method !== 'symlink') continue
    try {
      if (record.target === SHARED_TARGET) convertShared(db, home, record)
      else convertOwnFolder(db, home, record)
    } catch (err) {
      console.warn(`[convert] could not convert ${record.folderName}@${record.target}`, err)
    }
  }
}
