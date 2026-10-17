import type { ArtifactWriteRequest } from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'

export type ArtifactWriteBody = {
  content: string
  contentType: ArtifactWriteRequest['contentType']
  fileName: string
  title?: string
  review?: ArtifactWriteRequest['review']
  audience?: ArtifactWriteRequest['audience']
  sourceSessionRef?: string
}

export function artifactWriteBody(
  request: ArtifactWriteRequest,
  sourceSessionRef?: string
): ArtifactWriteBody {
  return {
    content: request.content,
    contentType: request.contentType,
    fileName: request.fileName,
    ...(request.title ? { title: request.title } : {}),
    // Why: omitted keys keep a plain share byte-identical and let PUT keep the server's values.
    ...(request.review ? { review: request.review } : {}),
    ...(request.audience ? { audience: request.audience } : {}),
    ...(sourceSessionRef ? { sourceSessionRef } : {})
  }
}

type ArtifactRequestOptions = {
  method?: string
  body?: unknown
  /** Raw bytes (a wake-copy part), sent as application/octet-stream instead of `body`. */
  bytes?: Uint8Array
  /** Answer with the raw bytes instead of parsed JSON. */
  binary?: true
  timeoutMs?: number
  editToken?: string
  idempotencyKey?: string
  sourceSessionRef?: string
}

export function artifactRequest<T>(
  apiUrl: string,
  token: string,
  path: string,
  options: ArtifactRequestOptions = {}
): Promise<T> {
  return artifactApiRequest<T>(apiUrl, token, `/v1/artifacts${path}`, options)
}

/** Any signed-in `/v1/…` route (the review inbox lives outside `/v1/artifacts`). */
export async function artifactApiRequest<T>(
  apiUrl: string,
  token: string,
  apiPath: string,
  options: ArtifactRequestOptions = {}
): Promise<T> {
  const response = await fetch(`${apiUrl}${apiPath}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.editToken ? { 'x-omni-edit-token': options.editToken } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.sourceSessionRef ? { 'x-omni-session-ref': options.sourceSessionRef } : {}),
      ...(options.bytes
        ? { 'content-type': 'application/octet-stream' }
        : options.body
          ? { 'content-type': 'application/json' }
          : {})
    },
    body: options.bytes
      ? (options.bytes as unknown as BodyInit)
      : options.body
        ? JSON.stringify(options.body)
        : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null
    throw new OrcaCloudRequestError(response.status, body?.code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  if (options.binary) {
    return Buffer.from(await response.arrayBuffer()) as T
  }
  return (await response.json()) as T
}

export async function deleteArtifactRequest(
  apiUrl: string,
  token: string,
  path: string,
  editToken?: string
): Promise<void> {
  try {
    await artifactRequest<void>(apiUrl, token, path, {
      method: 'DELETE',
      ...(editToken ? { editToken } : {})
    })
  } catch (error) {
    if (
      !(error instanceof OrcaCloudRequestError) ||
      error.statusCode !== 404 ||
      error.errorCode !== 'artifact_not_found'
    ) {
      throw error
    }
  }
}

export function artifactWriteBodiesMatch(
  left: ArtifactWriteBody,
  right: ArtifactWriteBody
): boolean {
  return (
    left.content === right.content &&
    left.contentType === right.contentType &&
    left.fileName === right.fileName &&
    left.title === right.title &&
    JSON.stringify(left.review) === JSON.stringify(right.review) &&
    left.audience === right.audience &&
    left.sourceSessionRef === right.sourceSessionRef
  )
}
