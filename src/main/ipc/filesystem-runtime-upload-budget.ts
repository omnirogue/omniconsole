export const RUNTIME_UPLOAD_MAX_SOURCES = 100
const MAX_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 10_000

/** One budget covers every selected source, including work discarded after an error. */
export class RuntimeUploadBudget {
  private bytes = 0
  private entries = 0

  reserve(bytes = 0): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytes + bytes > MAX_BYTES) {
      throw new Error('Remote import is too large')
    }
    if (this.entries >= MAX_ENTRIES) {
      throw new Error('Remote import contains too many files or folders')
    }
    this.bytes += bytes
    this.entries += 1
  }
}
