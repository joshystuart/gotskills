import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [bundleDir, outputDir, version, tag, repo] = process.argv.slice(2)
const archiveName = `Got-Skills-${version}-universal.app.tar.gz`
const signature = readFileSync(path.join(bundleDir, 'macos', 'Got Skills.app.tar.gz.sig'), 'utf8')

copyFileSync(
  path.join(bundleDir, 'macos', 'Got Skills.app.tar.gz'),
  path.join(outputDir, archiveName)
)

const url = `https://github.com/${repo}/releases/download/${tag}/${archiveName}`
const platform = { signature: signature.trim(), url }
const feed = {
  version,
  pub_date: new Date().toISOString(),
  platforms: { 'darwin-aarch64': platform, 'darwin-x86_64': platform },
}

writeFileSync(path.join(outputDir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`)
console.log(`latest.json points at ${url}`)
