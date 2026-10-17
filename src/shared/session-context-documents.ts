export const SESSION_CONTEXT_DOCUMENT_MAX_CHARS = 24_000
export const SESSION_CONTEXT_DOCUMENT_QUERY_MAX_CHARS = 2_048

export type SessionContextDocumentSource = 'slite' | 'omnios'

export type SessionContextDocumentReference = {
  source: SessionContextDocumentSource
  id: string
  title: string
  url: string
  updatedAt?: string | null
  preview?: string
}

export type ContextDocument = SessionContextDocumentReference

/** A saved read, so restoring a session does not depend on the document still being online. */
export type SessionContextDocumentSnapshot = SessionContextDocumentReference & {
  content: string
  contentType: 'text/markdown' | 'text/html'
  capturedAt: number
  truncated: boolean
}

export type SearchContextDocumentsRequest = {
  source: SessionContextDocumentSource
  query: string
  cursor?: string
}

export type ResolveContextDocumentRequest = {
  source: SessionContextDocumentSource
  id: string
}

export type SearchContextDocumentsResult =
  | { status: 'ok'; documents: SessionContextDocumentReference[]; nextCursor?: string }
  | { status: 'error'; message: string }

export type ResolveContextDocumentResult =
  | { status: 'ok'; document: SessionContextDocumentSnapshot }
  | { status: 'error'; message: string }
