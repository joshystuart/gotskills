import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const outputDir = process.argv[2]
const feed = parse(readFileSync(path.join(outputDir, 'latest-mac.yml'), 'utf8'))
const names = [...new Set([...feed.files.map((file) => file.url), feed.path])]
const built = readdirSync(outputDir)

const safeName = /^[A-Za-z0-9._-]+$/

const problems = [
  ...names
    .filter((name) => !built.includes(name))
    .map((name) => `latest-mac.yml lists "${name}", which is not in ${outputDir}`),
  ...names
    .filter((name) => !safeName.test(name))
    .map((name) => `"${name}" holds a character GitHub rewrites on upload`),
]

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(`latest-mac.yml matches the build output in ${outputDir}`)
