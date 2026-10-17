export type AutomationRunOutputSnapshot = {
  format: 'plain_text'
  content: string
  capturedAt: number
  truncated: boolean
  /** Assistant provenance is confirmed by the owning host, never accepted from renderer claims. */
  provenance?: 'assistant_message' | 'terminal_capture'
}

export type AutomationOutputBindingRequest = {
  automationId: string
  runId: string
  token: string
}
