import type { LocalWorkflowRunRequest } from '../../shared/local-workflow-run-request'
import { workflowRequestedByIdSchema } from '../../shared/workflow-agent-launch'
import { RuntimeClientError } from '../runtime-client'

type Flags = Map<string, string | boolean>

export function workflowRunFlagText(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** `--host`, `--force-host`, `--requested-by` and `--request`, checked together. */
export function workflowRunLaunchFlags(flags: Flags): Partial<LocalWorkflowRunRequest> {
  const host = workflowRunFlagText(flags, 'host')
  const forceHost = workflowRunFlagText(flags, 'force-host')
  const requestedBy = workflowRunFlagText(flags, 'requested-by')
  const requestedById = flags.get('requested-by-id')
  const request = workflowRunFlagText(flags, 'request')
  if (forceHost && !host) {
    throw new RuntimeClientError('invalid_argument', '--force-host needs --host <name>.')
  }
  if (host && workflowRunFlagText(flags, 'runs-on') === 'local') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host names a fleet host; it cannot go with --runs-on local.'
    )
  }
  if (flags.has('requested-by-id')) {
    if (!requestedBy) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--requested-by-id needs --requested-by <person>.'
      )
    }
    if (!workflowRequestedByIdSchema.safeParse(requestedById).success) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--requested-by-id must match ^emp_[a-z0-9_]{1,64}$.'
      )
    }
  }
  if (!!requestedBy !== !!request) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Give --requested-by "<person>" and --request "<their words>" together.'
    )
  }
  return {
    ...(host ? { host } : {}),
    ...(forceHost ? { forceHost } : {}),
    ...(requestedBy ? { requestedBy } : {}),
    ...(typeof requestedById === 'string' ? { requestedById } : {}),
    ...(request ? { request } : {})
  }
}
