import { isAbsolute } from 'node:path'

export type WorkflowProcessReceiptIdentity = {
  directory: string
  executionId: string
  hostId: string
  ownerIncarnation: string
  fence: number
  attemptId: string
  callId: string
  ordinal: number
  commandDigest: string
  inputDigest: string
  maxOutputBytes: number
}

export function assertWorkflowProcessReceiptIdentity(
  expected: WorkflowProcessReceiptIdentity
): void {
  if (
    !(
      process.platform !== 'win32' &&
      isAbsolute(expected.directory) &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(expected.attemptId) &&
      expected.executionId &&
      expected.hostId.trim() &&
      expected.ownerIncarnation.trim() &&
      expected.callId &&
      Number.isSafeInteger(expected.fence) &&
      expected.fence > 0 &&
      Number.isSafeInteger(expected.ordinal) &&
      expected.ordinal >= 1 &&
      expected.ordinal <= 3 &&
      /^[a-f0-9]{64}$/.test(expected.commandDigest) &&
      /^[a-f0-9]{64}$/.test(expected.inputDigest) &&
      Number.isSafeInteger(expected.maxOutputBytes) &&
      expected.maxOutputBytes > 0 &&
      expected.maxOutputBytes <= 8 * 1024 * 1024
    )
  ) {
    throw new Error('Invalid workflow process receipt identity')
  }
}
