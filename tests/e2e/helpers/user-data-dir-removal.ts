import { rmSync } from 'node:fs'

/** Removes a test profile once Electron has exited, retrying briefly for Windows file locks. */
export async function removeUserDataDirAfterShutdown(userDataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      // Why: Windows can briefly keep Electron profile files locked after the
      // process exits; retrying avoids turning a passed flow into teardown noise.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}
