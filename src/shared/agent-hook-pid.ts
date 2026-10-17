export function readAgentPid(value: unknown): number | undefined {
  const pid = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}
