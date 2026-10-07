import release from './electron-builder.config.mjs'

export default {
  ...release,
  electronFuses: {
    ...release.electronFuses,
    resetAdHocDarwinSignature: true,
  },
  mac: {
    ...release.mac,
    identity: null,
    notarize: false,
  },
}
