import { net, protocol } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

/**
 * Registered as privileged at import time, before app.ready, so relative asset
 * URLs resolve under this custom scheme.
 */
export const RENDERER_SCHEME = 'app'

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

/** Serve packaged renderer files over app:// instead of file:// (required when grantFileProtocolExtraPrivileges is false). */
export function registerRendererProtocol(rendererDir: string): void {
  protocol.handle(RENDERER_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
    const filePath = join(rendererDir, relativePath)
    return net.fetch(pathToFileURL(filePath).href, { bypassCustomProtocolHandlers: true })
  })
}

export function rendererEntryUrl(): string {
  return `${RENDERER_SCHEME}://./index.html`
}
