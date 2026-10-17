const STORAGE_KEY = 'omni.session-project-page.v1'

/** The project the Projects view showed last on this device, so a restart reopens it. */
export function rememberSessionProjectPage(folderId: string | null): void {
  try {
    if (folderId) {
      localStorage.setItem(STORAGE_KEY, folderId)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Why: presentation only; a storage failure must not block opening the page.
  }
}

export function recallSessionProjectPage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
