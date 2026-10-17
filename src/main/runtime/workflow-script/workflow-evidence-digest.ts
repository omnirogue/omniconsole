import { createHash } from 'node:crypto'

export const workflowEvidenceDigest = (text: string): string =>
  createHash('sha256').update(text).digest('hex')
