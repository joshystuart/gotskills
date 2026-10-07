import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === path.dirname(dir)) throw new Error(`Cannot find package '${name}' from ${fromDir}`)
  }
}

function productionDependencies(packageDir) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
}

export function dependencyUnpackGlobs(packageName, projectDir) {
  const names = new Set()
  const visited = new Set()

  function visit(name, fromDir) {
    const packageDir = findPackageDir(name, fromDir)
    if (visited.has(packageDir)) return
    visited.add(packageDir)
    names.add(name)
    for (const dependency of productionDependencies(packageDir)) visit(dependency, packageDir)
  }

  visit(packageName, projectDir)
  return [...names].sort().map((name) => `**/node_modules/${name}/**`)
}
