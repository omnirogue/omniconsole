export function getAutomationHubRefusal(hubTaskId?: string | null): string | null {
  return hubTaskId
    ? `This workspace is linked to omnios card ${hubTaskId}. Schedule and run its recurring work from omnios at https://console.example.com.`
    : null
}

export function assertAutomationHubAuthority(hubTaskId?: string | null): void {
  const refusal = getAutomationHubRefusal(hubTaskId)
  if (refusal) {
    throw new Error(refusal)
  }
}
