/** Persisted at launch; absent/old dispatch records always retain manual release semantics. */
export type WorkerCompletionPolicy = {
  kind: 'release_on_accepted_completion'
  coordinator: { worktreeId: string; paneKey: string }
}

export function readWorkerCompletionPolicy(startOptions: string): WorkerCompletionPolicy | null {
  try {
    const value = JSON.parse(startOptions)?.completionPolicy
    if (
      value?.kind !== 'release_on_accepted_completion' ||
      typeof value.coordinator?.worktreeId !== 'string' ||
      !value.coordinator.worktreeId ||
      typeof value.coordinator?.paneKey !== 'string' ||
      !value.coordinator.paneKey
    ) {
      return null
    }
    return {
      kind: value.kind,
      coordinator: {
        worktreeId: value.coordinator.worktreeId,
        paneKey: value.coordinator.paneKey
      }
    }
  } catch {
    return null
  }
}
