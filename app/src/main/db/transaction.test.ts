import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { transaction } from './transaction'

it('commits successful writes and returns the result', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE item (name TEXT)')
  expect(
    transaction(db, () => {
      db.prepare('INSERT INTO item VALUES (?)').run('kept')
      return 'result'
    })
  ).toBe('result')
  expect(db.prepare('SELECT name FROM item').get()).toEqual({ name: 'kept' })
  db.close()
})

it('rolls back every write and rethrows the original error', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE item (name TEXT)')
  const error = new Error('failed')
  let caught: unknown
  try {
    transaction(db, () => {
      db.prepare('INSERT INTO item VALUES (?)').run('discarded')
      db.prepare('INSERT INTO item VALUES (?)').run('also discarded')
      throw error
    })
  } catch (failure) {
    caught = failure
  }
  expect(caught).toBe(error)
  expect(db.prepare('SELECT name FROM item').all()).toEqual([])
  db.close()
})
