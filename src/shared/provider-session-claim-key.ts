import type { SleepingAgentSessionRecord } from './agent-session-resume'

export function getProviderSessionClaimKey(
  record: Pick<SleepingAgentSessionRecord, 'worktreeId' | 'providerSession'> & { agent: string }
): string {
  const base = `${record.worktreeId}\0${record.agent}\0${record.providerSession.key}\0${record.providerSession.id}`
  return record.agent === 'pi' || record.agent === 'prime-agent'
    ? `${base}\0${record.providerSession.transcriptPath ?? ''}`
    : base
}
