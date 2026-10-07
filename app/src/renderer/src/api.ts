import type { RendererApi } from '../../shared/ipc'

/** Read the preload-exposed API. Throws if the preload bridge is missing. */
export function getApi(): RendererApi {
  const api = (window as unknown as { api?: RendererApi }).api
  if (!api) {
    throw new Error('window.api is unavailable — the preload bridge did not load')
  }
  return api
}
