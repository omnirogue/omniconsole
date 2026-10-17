import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type RetainedPointerNavigationMode = 'navigate' | 'fetch'

export type RetainedPointerEvent = {
  trusted: boolean
  targetId: string
  targetTag: string
  innerWidth: number
  innerHeight: number
  screenWidth: number
  screenHeight: number
  documentId: string
}

export async function startRetainedBrowserPointerFixture(
  port = 0,
  navigationMode: RetainedPointerNavigationMode = 'navigate'
) {
  const clicks: RetainedPointerEvent[] = []
  let activations = 0
  const filename = 'retained-browser-pointer.bin'
  const bytes = Buffer.concat([
    Buffer.from('Retained client browser pointer transfer\n'),
    Buffer.from([0, 255, 1, 128])
  ])
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/click-event' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        clicks.push(JSON.parse(Buffer.concat(chunks).toString()) as RetainedPointerEvent)
        response.writeHead(204).end()
      })
      return
    }
    if (pathname === '/download') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': bytes.length
      })
      response.end(bytes)
      return
    }
    if (pathname === '/activation') {
      activations += 1
    }
    const marker = pathname === '/visible' ? 'user-visible' : 'automation-target'
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    // Deliberately omit viewport meta: mobile emulation may produce a 980px layout.
    response.end(`<!doctype html><html data-retained-pointer-document-id="${randomUUID()}"><head><title>${marker}</title></head>
      <body style="margin:24px"><h1 id="marker">${marker}</h1>
      <input id="user-focus" aria-label="User draft" value="user draft">
      <a id="activate" href="/activation" style="display:block;padding:24px">Activate test link</a>
      <a id="download" href="/download" style="display:block;padding:24px">Download test file</a>
      <script>
        document.addEventListener('click', (event) => {
          const target = event.target.closest('a');
          if (!target) return;
          if (target.id === 'activate' && ${JSON.stringify(navigationMode)} === 'fetch') {
            // This fixture models a link handled by the page without navigating.
            event.preventDefault();
            fetch(target.href);
          }
          fetch('/click-event', { method: 'POST', keepalive: true, body: JSON.stringify({
            trusted: event.isTrusted, targetId: target.id, targetTag: target.tagName,
            innerWidth, innerHeight, screenWidth: screen.width, screenHeight: screen.height,
            documentId: document.documentElement.dataset.retainedPointerDocumentId
          }) });
        }, true);
      </script></body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    bytes,
    clicks,
    filename,
    origin,
    activations: () => activations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
