import path from 'node:path'
import { dependencyUnpackGlobs } from './dependencyUnpackGlobs.mjs'

describe('dependencyUnpackGlobs', () => {
  it('unpacks skills and its whole production dependency tree', () => {
    const globs = dependencyUnpackGlobs('skills', path.resolve(__dirname, '..'))

    expect(globs).toEqual(
      expect.arrayContaining(
        [
          'skills',
          'tar',
          '@isaacs/fs-minipass',
          'chownr',
          'minipass',
          'minizlib',
          'yallist',
          'yaml',
        ].map((name) => `**/node_modules/${name}/**`)
      )
    )
  })
})
