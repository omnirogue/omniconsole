import { parentPort, workerData } from 'node:worker_threads'
import { webPageText } from './web-page-text'

// Must stay electron-free: it runs as a worker thread, where electron cannot be required.
const data = workerData as { body?: unknown; type?: unknown; charset?: unknown }

if (!parentPort) {
  throw new Error('The web page text worker must run with a parent port.')
}

parentPort.postMessage(
  webPageText(
    data.body instanceof Uint8Array ? data.body : new Uint8Array(),
    typeof data.type === 'string' ? data.type : 'text/plain',
    typeof data.charset === 'string' ? data.charset : null
  )
)
