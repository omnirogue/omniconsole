export type NativePeerInboxBinding = {
  key: string
  peerSessionId: string
  employeeId: string
  companyId: string
  projectId: string
  taskId: string
  apiOrigin: string
  tokenFile: string
  runtimeId: string
  terminalHandle: string
  ptyId: string
  incarnation: string
  executionHostId: string
  workspaceId: string
  paneKey: string
  provider: 'claude' | 'codex'
  providerSessionId: string
  nativeSessionId: string
  runtimeFence: number
  wakeConsent: boolean
}

export type NativePeerInboxReceipt = {
  binding: NativePeerInboxBinding
  attempt: {
    nonce: string
    nativeItemId?: string
    outcome: 'uncertain' | 'submitted' | 'completed' | 'not-written'
  } | null
}

const STRING_FIELDS = [
  'key',
  'peerSessionId',
  'employeeId',
  'companyId',
  'projectId',
  'taskId',
  'apiOrigin',
  'runtimeId',
  'terminalHandle',
  'ptyId',
  'incarnation',
  'executionHostId',
  'workspaceId',
  'paneKey',
  'providerSessionId',
  'nativeSessionId'
] as const

export function isNativePeerInboxBinding(value: unknown): value is NativePeerInboxBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const binding = value as Partial<NativePeerInboxBinding>
  const allowed = new Set<string>([
    ...STRING_FIELDS,
    'tokenFile',
    'provider',
    'runtimeFence',
    'wakeConsent'
  ])
  return (
    Object.keys(binding).every((key) => allowed.has(key)) &&
    /^[A-Za-z0-9_.:-]+$/.test(binding.terminalHandle ?? '') &&
    STRING_FIELDS.every(
      (key) =>
        typeof binding[key] === 'string' &&
        binding[key]!.length > 0 &&
        binding[key]!.length <= 512 &&
        [...binding[key]!].every((character) => character.charCodeAt(0) >= 32)
    ) &&
    typeof binding.tokenFile === 'string' &&
    binding.tokenFile.length > 0 &&
    binding.tokenFile.length <= 4096 &&
    [...binding.tokenFile].every((character) => character.charCodeAt(0) >= 32) &&
    (binding.provider === 'claude' || binding.provider === 'codex') &&
    typeof binding.runtimeFence === 'number' &&
    Number.isSafeInteger(binding.runtimeFence) &&
    binding.runtimeFence >= 0 &&
    typeof binding.wakeConsent === 'boolean'
  )
}

export function isNativePeerInboxReceipt(value: unknown): value is NativePeerInboxReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const receipt = value as Partial<NativePeerInboxReceipt>
  const attempt = receipt.attempt
  return (
    isNativePeerInboxBinding(receipt.binding) &&
    (attempt === null ||
      (typeof attempt === 'object' &&
        attempt !== undefined &&
        typeof attempt.nonce === 'string' &&
        attempt.nonce.length > 0 &&
        attempt.nonce.length <= 128 &&
        (attempt.nativeItemId === undefined ||
          (typeof attempt.nativeItemId === 'string' && attempt.nativeItemId.length <= 128)) &&
        ['uncertain', 'submitted', 'completed', 'not-written'].includes(attempt.outcome)))
  )
}
