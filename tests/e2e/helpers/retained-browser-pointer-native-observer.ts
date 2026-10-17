import type { PairedElectronClient } from './paired-electron-client'

export async function installRetainedPointerNativeObserver(
  client: PairedElectronClient,
  nativeIds: number[]
) {
  const handle = await client.app.evaluateHandle(({ BrowserWindow, webContents }, ids) => {
    const guests = ids.map((id) => {
      const guest = webContents.fromId(id)
      if (!guest || guest.isDestroyed()) {
        throw new Error(`retained pointer guest ${id} unavailable`)
      }
      return guest
    })
    const installed: { id: number; event: string }[] = []
    const counts: Record<string, number> = {}
    const events: Record<string, unknown>[] = []
    const detach: (() => void)[] = []
    let stopped = false
    let dropped = 0
    const record = (id: number, event: string, details: Record<string, unknown> = {}) => {
      if (stopped) {
        return
      }
      const key = `${id}:${event}`
      counts[key] = (counts[key] ?? 0) + 1
      if (events.length >= 256) {
        dropped += 1
        return
      }
      events.push({
        id,
        event,
        mainTimeMs: Date.now(),
        focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
        ...details
      })
    }
    for (const guest of guests) {
      const id = guest.id
      const input = (_event: Electron.Event, mouse: Electron.MouseInputEvent) =>
        record(id, 'before-mouse-event', {
          type: mouse.type,
          x: mouse.x,
          y: mouse.y,
          button: mouse.button
        })
      const start = (
        _event: Electron.Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => record(id, 'did-start-navigation', { url, isInPlace, isMainFrame })
      const commit = (_event: Electron.Event, url: string) => record(id, 'did-navigate', { url })
      const load = () => record(id, 'did-finish-load')
      const focus = () => record(id, 'focus')
      const blur = () => record(id, 'blur')
      guest.on('before-mouse-event', input)
      guest.on('did-start-navigation', start)
      guest.on('did-navigate', commit)
      guest.on('did-finish-load', load)
      guest.on('focus', focus)
      guest.on('blur', blur)
      for (const event of [
        'before-mouse-event',
        'did-start-navigation',
        'did-navigate',
        'did-finish-load',
        'focus',
        'blur'
      ]) {
        installed.push({ id, event })
        counts[`${id}:${event}`] = 0
      }
      detach.push(() => {
        guest.off('before-mouse-event', input)
        guest.off('did-start-navigation', start)
        guest.off('did-navigate', commit)
        guest.off('did-finish-load', load)
        guest.off('focus', focus)
        guest.off('blur', blur)
      })
    }
    const read = () => ({
      mainTimeMs: Date.now(),
      installed,
      counts,
      events,
      dropped,
      stopped,
      focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    })
    return {
      read,
      stop: () => {
        stopped = true
        for (const remove of detach) {
          remove()
        }
        return read()
      }
    }
  }, nativeIds)
  return {
    read: () => handle.evaluate((observer) => observer.read()),
    dispose: async () => {
      try {
        return await handle.evaluate((observer) => observer.stop())
      } finally {
        await handle.dispose()
      }
    }
  }
}

export async function readRetainedPointerDocument(client: PairedElectronClient, nativeId: number) {
  return client.app.evaluate(async ({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed()) {
      throw new Error(`retained pointer document ${id} unavailable`)
    }
    const requestedAtMs = Date.now()
    const document = (await guest.executeJavaScript(
      '({ documentId: document.documentElement.dataset.retainedPointerDocumentId, url: location.href })',
      false
    )) as { documentId: string; url: string }
    return { requestedAtMs, completedAtMs: Date.now(), document }
  }, nativeId)
}
