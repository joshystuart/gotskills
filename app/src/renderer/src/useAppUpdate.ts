import { useEffect, useState } from 'react'
import type { AppUpdateState, RendererApi } from '../../shared/ipc'

export function useAppUpdate(api: RendererApi) {
  const [state, setState] = useState<AppUpdateState | null>(null)
  useEffect(() => {
    let active = true
    let received = false
    const unsubscribe = api.onAppUpdateState((next) => {
      received = true
      if (active) setState(next)
    })
    void api.getAppUpdateState().then((initial) => {
      if (active && !received) setState(initial)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])
  return {
    state,
    download: () => void api.downloadAppUpdate(),
    restart: () => void api.restartForAppUpdate(),
  }
}
