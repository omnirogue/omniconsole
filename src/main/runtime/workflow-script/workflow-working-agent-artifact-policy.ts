export function workingAgentCallNeedsArtifacts(callId: string): boolean {
  return callId.startsWith('answers/') || callId === 'synthesis/final'
}
