import type { BrowserViewportOverride } from './browser-workspace-types'

export type BrowserClientAutomationVisibilityIdentity = {
  browserPageId: string
  pageHostGeneration: number
  webContentsId: number
}

// Main/renderer lease data stays inside the guest-owning desktop.
export type BrowserClientAutomationVisibilityRequest = BrowserClientAutomationVisibilityIdentity & {
  viewportOverride: BrowserViewportOverride | null
  embedderZoomFactor: number
}

export type BrowserClientAutomationVisibilityReady = BrowserClientAutomationVisibilityIdentity & {
  token: string
}
