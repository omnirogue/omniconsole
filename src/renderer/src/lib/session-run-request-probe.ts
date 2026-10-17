/**
 * Lets the pane notification path ask "does a run this pane works for already carry a request?"
 * without importing the chain registry, whose import graph is far heavier than a hook may load.
 * The registry installs the probe when it loads; with none installed nothing is suppressed.
 */
type SessionRunRequestProbe = (paneKey: string, now: number) => boolean

let installed: SessionRunRequestProbe | null = null

export function setSessionRunRequestProbe(probe: SessionRunRequestProbe | null): void {
  installed = probe
}

export function sessionRunRequestCoversPane(paneKey: string, now = Date.now()): boolean {
  return installed?.(paneKey, now) ?? false
}
