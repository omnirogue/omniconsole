import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { WorkflowRunsOn } from '../../../../shared/local-workflow-placement'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowFleetHosts
} from '../../../../shared/local-workflow-rpc'
import type { SshTarget } from '../../../../shared/ssh-types'
import { workflowRunsOnLabel } from './workflow-runs-on-label'

export type WorkflowFleetHost = LocalWorkflowFleetHosts['hosts'][number]
type SshTargetIdentity = Pick<SshTarget, 'id' | 'host' | 'configHost'>

/** Where a Start runs: the fleet chooses, this computer, or a fleet host by name. */
export type WorkflowRunOnChoice = {
  runsOn: WorkflowRunsOn
  runsOnHost?: string
  runsOnHostId?: string
}

const HOST_VALUE_PREFIX = 'host:'

export function workflowRunOnValue(choice: WorkflowRunOnChoice): string {
  return choice.runsOnHost ? `${HOST_VALUE_PREFIX}${choice.runsOnHost}` : choice.runsOn
}

export function workflowRunOnOptions(
  hosts: readonly WorkflowFleetHost[],
  choice: WorkflowRunOnChoice
): { value: string; label: string }[] {
  const named = hosts.map((host) => ({
    value: `${HOST_VALUE_PREFIX}${host.name}`,
    label: host.local
      ? translate('workflowGraph.setup.runsOnHostHere', 'Run on: {{name}} (this computer)', {
          name: host.name
        })
      : translate('workflowGraph.setup.runsOnHost', 'Run on: {{name}}', { name: host.name })
  }))
  // A saved host the list no longer (or not yet) offers still shows as the selection.
  if (choice.runsOnHost && !hosts.some((host) => host.name === choice.runsOnHost)) {
    named.push({
      value: workflowRunOnValue(choice),
      label: translate('workflowGraph.setup.runsOnHost', 'Run on: {{name}}', {
        name: choice.runsOnHost
      })
    })
  }
  return [
    { value: 'fleet', label: workflowRunsOnLabel('fleet') },
    { value: 'local', label: workflowRunsOnLabel('local') },
    ...named
  ]
}

/**
 * A named host runs through the fleet; its host id is `local` for this computer, or the SSH
 * target whose alias or host is exactly the host's SSH name, and absent when none matches.
 */
export function workflowRunOnPick(
  value: string,
  hosts: readonly WorkflowFleetHost[],
  targets: readonly SshTargetIdentity[]
): WorkflowRunOnChoice {
  if (!value.startsWith(HOST_VALUE_PREFIX)) {
    return { runsOn: value === 'local' ? 'local' : 'fleet' }
  }
  const name = value.slice(HOST_VALUE_PREFIX.length)
  const host = hosts.find((entry) => entry.name === name)
  const ssh = host?.ssh
  const targetId = ssh
    ? targets.find((target) => target.configHost === ssh || target.host === ssh)?.id
    : undefined
  const runsOnHostId = host?.local ? 'local' : targetId ? `ssh:${targetId}` : undefined
  return { runsOn: 'fleet', runsOnHost: name, ...(runsOnHostId ? { runsOnHostId } : {}) }
}

/** Replaces a draft's placement fields, dropping host fields the new choice does not carry. */
export function withWorkflowRunOnChoice<T extends Partial<WorkflowRunOnChoice>>(
  draft: T,
  choice: WorkflowRunOnChoice
): T {
  const next = { ...draft, ...choice }
  if (!choice.runsOnHost) {
    delete next.runsOnHost
  }
  if (!choice.runsOnHostId) {
    delete next.runsOnHostId
  }
  return next
}

async function readFleetHosts(): Promise<WorkflowFleetHost[]> {
  try {
    const result = await callRuntimeRpc<LocalWorkflowFleetHosts>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.fleetHosts,
      {}
    )
    return Array.isArray(result?.hosts) ? result.hosts : []
  } catch {
    // An older runtime without the method, or an unreadable hosts file: no named hosts.
    return []
  }
}

async function readSshTargets(): Promise<SshTargetIdentity[]> {
  try {
    const targets = (await window.api?.ssh?.listTargets?.()) as SshTargetIdentity[] | undefined
    return Array.isArray(targets) ? targets : []
  } catch {
    return []
  }
}

/** The fleet hosts "Run on" offers and the SSH targets a pick resolves against, read once. */
export function useWorkflowRunOnHosts(): {
  hosts: WorkflowFleetHost[]
  targets: SshTargetIdentity[]
} {
  const [state, setState] = useState<{
    hosts: WorkflowFleetHost[]
    targets: SshTargetIdentity[]
  }>({ hosts: [], targets: [] })
  useEffect(() => {
    let live = true
    void Promise.all([readFleetHosts(), readSshTargets()]).then(([hosts, targets]) => {
      if (live) {
        setState({ hosts, targets })
      }
    })
    return () => {
      live = false
    }
  }, [])
  return state
}
