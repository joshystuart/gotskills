import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencyUnpackGlobs } from './scripts/dependencyUnpackGlobs.mjs'

const projectDir = path.dirname(fileURLToPath(import.meta.url))

export default {
  appId: 'com.igotskills.app',
  productName: 'Got Skills',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  files: ['out/**'],
  asarUnpack: [...dependencyUnpackGlobs('skills', projectDir)],
  electronLanguages: ['en'],
  artifactName: '${productName}-${version}-${arch}.${ext}',
  publish: { provider: 'github', owner: 'joshystuart', repo: 'gotskills' },
  afterPack: ({ targets }) => {
    for (const target of targets) {
      if (target.name === 'dmg') target.options.format = 'ULMO'
    }
  },
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: true,
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
  },
  dmg: {
    title: 'Got Skills',
    artifactName: '${productName}-${version}-${arch}.${ext}',
    format: 'ULFO',
    window: { width: 660, height: 400 },
    iconSize: 128,
    contents: [
      { x: 180, y: 200, type: 'file' },
      { x: 480, y: 200, type: 'link', path: '/Applications' },
    ],
  },
}
