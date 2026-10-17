import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

type DocumentOpener = (url: string, worktreeId?: string | null) => boolean
type FileOpener = (path: string, context: RuntimeFileOperationArgs) => boolean
let documentOpener: DocumentOpener | null = null
let fileOpener: FileOpener | null = null

/** Presentation routing only; readers still enforce account and execution-host access. */
export function registerSessionDocumentRouting(documents: DocumentOpener, files: FileOpener) {
  documentOpener = documents
  fileOpener = files
  return () => {
    if (documentOpener === documents) {
      documentOpener = null
    }
    if (fileOpener === files) {
      fileOpener = null
    }
  }
}

export function tryOpenSessionDocument(url: string, worktreeId?: string | null): boolean {
  return documentOpener?.(url, worktreeId) ?? false
}

export function captureSessionFileOpener() {
  const captured = fileOpener
  return (path: string, context: RuntimeFileOperationArgs) =>
    captured !== null && captured === fileOpener && captured(path, context)
}
