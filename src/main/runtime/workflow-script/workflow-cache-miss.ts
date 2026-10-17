export class WorkflowCacheMissError extends Error {
  constructor(callId: string) {
    super(`Workflow result is not committed: ${callId}`)
  }
}
