export type ProviderLoginInteraction = {
  signal: AbortSignal
  onOutput: (output: string) => void
  setInput?: (write: ((code: string) => void) | null) => void
}
