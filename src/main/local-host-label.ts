import { hostname } from 'node:os'

/** How people name this machine: the short host name without `.local`/`.lan`. */
export function localHostLabel(): string {
  return hostname().replace(/\.(local|lan|home|internal)$/i, '') || 'this computer'
}
