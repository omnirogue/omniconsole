let homePromise: Promise<string> | null = null

/** The host's home directory, read once — every company path is resolved against it. */
export async function getCompanyFolderHome(): Promise<string> {
  homePromise ??= Promise.resolve(window.api?.companyWorkspaces?.home?.() ?? '').catch(() => '')
  const home = await homePromise
  // Why: an unanswered read must not become the home for the rest of the process.
  if (!home) {
    homePromise = null
  }
  return home
}

/** Test seam: forget the cached home between cases. */
export function resetCompanyFolderHomeCache(): void {
  homePromise = null
}
