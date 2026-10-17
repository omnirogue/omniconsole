/** Bounded lookup for the stable owner key after runtime has returned the terminal handle. */
export async function resolveSessionPrepTerminalPaneKey(
  runtime: { getTerminalPaneKey?(handle: string): string | null },
  handle: string
): Promise<string | null> {
  if (!runtime.getTerminalPaneKey) {
    return null
  }
  const deadline = Date.now() + 15_000
  let paneKey = runtime.getTerminalPaneKey(handle)
  while (!paneKey && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    paneKey = runtime.getTerminalPaneKey(handle)
  }
  return paneKey
}
