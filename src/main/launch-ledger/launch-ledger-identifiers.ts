import { createHash } from 'node:crypto'
import { isLaunchUuid, isLaunchPaneKey } from '../../shared/launch-identifiers'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

export function ledgerIdentifier(
  kind: 'ptyId' | 'paneKey' | 'tabId' | 'worktreeId',
  value: unknown
): string | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  if (
    kind === 'worktreeId' &&
    /^[0-9a-f-]{36}::hash_[0-9a-f]{12}$/.test(value) &&
    isLaunchUuid(value.split('::')[0])
  ) {
    return value
  }
  if (/^opaque_[0-9a-f]{64}$/.test(value)) {
    return value
  }
  let valid = false
  if (kind === 'tabId') {
    valid = isLaunchUuid(value)
  }
  if (kind === 'paneKey') {
    valid = isLaunchPaneKey(value)
  }
  if (kind === 'ptyId') {
    const ssh = parseAppSshPtyId(value)
    valid =
      isLaunchUuid(value) ||
      /^\d+$/.test(value) ||
      /^pty-\d+$/.test(value) ||
      Boolean(
        ssh &&
        /^(?:[0-9a-f-]{36}|ssh-\d{13}-[a-z0-9]+)$/.test(ssh.connectionId) &&
        (isLaunchUuid(ssh.relayPtyId) ||
          /^\d+$/.test(ssh.relayPtyId) ||
          /^pty-\d+$/.test(ssh.relayPtyId))
      )
  }
  if (kind === 'worktreeId') {
    if (value.startsWith('folder:') && isLaunchUuid(value.slice(7))) {
      return value
    }
    const prefix = value.split('::')[0]
    const suffixHash = createHash('sha256').update(value).digest('hex').slice(0, 12)
    if (value.includes('::') && isLaunchUuid(prefix)) {
      return `${prefix}::hash_${suffixHash}`
    }
  }
  // Legacy/custom host IDs remain correlatable without retaining their potentially private spelling.
  return valid ? value : `opaque_${createHash('sha256').update(`${kind}\0${value}`).digest('hex')}`
}

export function hashLaunchCorrelationId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
