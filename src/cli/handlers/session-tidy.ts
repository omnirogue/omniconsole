// `omni session tidy`: plan a cleanup over every sidebar conversation (archive, or with --delete,
// delete) and apply it when the person asks. The plan and the checks live in the runtime.

import { SESSION_MANAGE_RPC, type SessionTidyResult } from '../../shared/session-manage-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { formatSessionTidy, sessionTidyReport } from '../session-tidy-format'
import { refuseRemote } from './session-manage-access'
import { parseHost } from './session-host-flag'
import { sessionProvenance } from './session-provenance-flags'

const TIDY_TIMEOUT_MS = 300_000

export const sessionTidyHandler: CommandHandler = async ({ client, flags, json }) => {
  refuseRemote(client)
  const apply = flags.get('apply') === true
  const deleting = flags.get('delete') === true
  const unverified = flags.get('unverified') === true
  const { reason, request } = sessionProvenance(flags)
  if (unverified && !deleting) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--unverified goes with --delete: archive never acts on a session this computer cannot verify. Nothing changed.'
    )
  }
  if (apply && !request) {
    throw new RuntimeClientError(
      'invalid_argument',
      `session tidy --apply needs --request "<the person's own words>": ${deleting ? 'deleting' : 'archiving'} runs only when the person asks for it. Nothing changed.`
    )
  }
  const hostId = parseHost(getOptionalStringFlag(flags, 'host'))
  const include = getOptionalStringFlag(flags, 'include')
    ?.split(',')
    .map((paneKey) => paneKey.trim())
    .filter(Boolean)
  const response = await client.call<SessionTidyResult>(
    SESSION_MANAGE_RPC.tidy,
    {
      ...(apply ? { apply: true } : {}),
      ...(deleting ? { delete: true } : {}),
      ...(unverified ? { unverified: true } : {}),
      ...(hostId ? { hostId } : {}),
      ...(include?.length ? { include } : {}),
      ...(reason ? { reason } : {}),
      ...(request ? { request } : {})
    },
    { timeoutMs: TIDY_TIMEOUT_MS }
  )
  const result = response.result
  // Why non-zero on nothing archived: an agent must not report a no-op cleanup as done.
  const report = result.dryRun ? undefined : sessionTidyReport(result.rows)
  if (report) {
    result.report = report
  }
  printResult(response, json, formatSessionTidy)
  const done = deleting ? (report?.deleted?.length ?? 0) : (report?.archived.length ?? 0)
  if (report && (!done || report.failed.length)) {
    process.exitCode = 1
  }
}
