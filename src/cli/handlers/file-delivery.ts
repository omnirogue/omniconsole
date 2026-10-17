import type {
  WorkspaceFileDeliveryRequest,
  WorkspaceFileDeliveryResult
} from '../../shared/workspace-file-delivery'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

export const deliverFile: CommandHandler = async ({ flags, client, json }) => {
  const desktopName = getOptionalStringFlag(flags, 'desktop-name')
  const destinationPath = getOptionalStringFlag(flags, 'destination')
  if (Boolean(desktopName) === Boolean(destinationPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose exactly one recipient destination: --desktop-name or --destination.'
    )
  }
  const request: WorkspaceFileDeliveryRequest = {
    worktree: getRequiredStringFlag(flags, 'worktree'),
    sourcePath: getRequiredStringFlag(flags, 'path'),
    expectedSourceHostId: getRequiredStringFlag(flags, 'source-host'),
    recipientRuntimeId: getRequiredStringFlag(flags, 'recipient-runtime-id'),
    expectedSha256: getOptionalStringFlag(flags, 'sha256'),
    destination: desktopName
      ? { kind: 'desktop', name: desktopName }
      : { kind: 'path', path: destinationPath! }
  }
  const reply = await client.call<WorkspaceFileDeliveryResult>('files.deliver', request, {
    timeoutMs: 240_000
  })
  printResult(
    reply,
    json,
    (result) =>
      `${result.disposition === 'delivered' ? 'Delivered' : 'Verified existing file'}: ${result.recipient.path} on ${result.recipient.hostname}\nSHA-256: ${result.sha256} (${result.size} bytes)`
  )
}
