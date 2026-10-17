import type { ComputerActionResult, ComputerSnapshotResult } from '../../shared/runtime-types'
import { actOnTerminalAccessibleRenderer } from './terminal-accessible-renderer'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { decodeTerminalAccessiblePaneToken } from '../../shared/terminal-accessible-pane-token'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { RuntimeClientError } from './runtime-client-error'
import { assertSelfTargetAccessibilityTree } from './self-target-accessibility-tree'
import {
  enableSelfTargetAccessibility,
  prepareSelfTargetedComputerRequest,
  selfTargetAccessibilityActive
} from './self-target-accessibility'
import { callComputerSidecarAction, callComputerSidecarSnapshot } from './sidecar-client'

type Target = {
  app: string
  session?: string
  worktree?: string
  windowId?: number
  windowIndex?: number
  elementIndex?: number
  value?: string
  mouseButton?: string
  clickCount?: number
  modifiers?: string
}
type Action = Parameters<typeof callComputerSidecarAction>[0]
type Runtime = Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'focusTerminal'>
type ObservedPane = { paneKey: string; handle: string | null }
const snapshots = new Map<string, Map<number, ObservedPane>>()

function targetKey(target: Target): string {
  return JSON.stringify([
    target.app,
    target.session,
    target.worktree,
    target.windowId,
    target.windowIndex
  ])
}

export function resetTerminalAccessibleSnapshots(): void {
  snapshots.clear()
}

function remember<T extends ComputerSnapshotResult>(
  target: Target,
  result: T,
  runtime: Runtime
): T {
  const panes = new Map<number, ObservedPane>()
  if (result?.snapshot?.app?.pid === process.pid && typeof result.snapshot.treeText === 'string') {
    for (const row of result.snapshot.treeText.split('\n')) {
      const match = row.match(/^\s*(\d+) text field .*\(omni-terminal=([^\s)]+)\)/)
      if (!match) {
        continue
      }
      const paneKey = decodeTerminalAccessiblePaneToken(match[2])
      if (!paneKey || !parsePaneKey(paneKey)) {
        continue
      }
      let handle: string | null = null
      try {
        handle = runtime.resolveTerminalPane(paneKey).handle
      } catch {
        /* Stale inputs must refuse. */
      }
      panes.set(Number(match[1]), { paneKey, handle })
    }
  }
  const key = targetKey(target)
  snapshots.delete(key)
  snapshots.set(key, panes)
  if (snapshots.size > 64) {
    snapshots.delete(snapshots.keys().next().value!)
  }
  return result
}

export async function observeTerminalAccessibleSnapshot(
  target: Target,
  runtime: Runtime
): Promise<ComputerSnapshotResult> {
  const selfTargeted = await prepareSelfTargetedComputerRequest(target.app, { requireFocus: false })
  const result = await snapshotWithoutTreeAssertion(target, runtime)
  // ONE definition of "this observation is us", used for both the enable and the
  // judgement: the snapshot's own pid. A selector match alone is not it — it can name a
  // sibling install (the dev copy beside the packaged app), whose chrome-only tree is
  // not ours to judge — and a selector MISS is not the opposite of it: the app name the
  // tool lists on Windows and Linux ('Orca') resolves this very window, so the request
  // arrives looking foreign.
  if (!selfTargetAccessibilityActive() || result?.snapshot?.app?.pid !== process.pid) {
    return result
  }
  // Why enable here too: without it the refusal below asks for a retry that can never
  // repair anything, because nothing ever published the renderer tree.
  const accessibilityEnabled = selfTargeted || enableSelfTargetAccessibility()
  assertSelfTargetAccessibilityTree(result, { accessibilityEnabled })
  return result
}

async function snapshotWithoutTreeAssertion(
  target: Target,
  runtime: Runtime
): Promise<ComputerSnapshotResult> {
  return remember(target, await callComputerSidecarSnapshot(target), runtime)
}

export async function performTerminalAccessibleAction(
  method: Action,
  target: Target,
  runtime: Runtime
): Promise<ComputerActionResult> {
  await prepareSelfTargetedComputerRequest(target.app, { requireFocus: true })
  const observed =
    (method === 'click' || method === 'setValue') && target.elementIndex !== undefined
      ? snapshots.get(targetKey(target))?.get(target.elementIndex)
      : null
  if (!observed) {
    return remember(target, await callComputerSidecarAction(method, target), runtime)
  }
  if (
    method === 'click' &&
    ((target.mouseButton && target.mouseButton !== 'left') ||
      (target.clickCount !== undefined && target.clickCount !== 1) ||
      target.modifiers)
  ) {
    throw new RuntimeClientError(
      'action_not_supported',
      'Terminal input supports a plain focus click'
    )
  }
  // Resolve the observed identity, never a fresh element index that may now name a sibling.
  if (!observed.handle) {
    throw new RuntimeClientError(
      'element_not_found',
      'Terminal pane is no longer available; observe again'
    )
  }
  const terminal = runtime.resolveTerminalPane(observed.paneKey)
  if (terminal.handle !== observed.handle) {
    throw new RuntimeClientError('element_not_found', 'Terminal pane changed; observe again')
  }
  const focused = await runtime.focusTerminal(terminal.handle, { navigateHost: true })
  if (!focused.navigated) {
    throw new RuntimeClientError('window_not_focused', 'Terminal pane could not be revealed')
  }
  if (runtime.resolveTerminalPane(observed.paneKey).handle !== observed.handle) {
    throw new RuntimeClientError(
      'element_not_found',
      'Terminal pane changed during focus; observe again'
    )
  }
  await actOnTerminalAccessibleRenderer(
    observed.paneKey,
    method === 'setValue' ? target.value : undefined
  )
  return {
    ...(await snapshotWithoutTreeAssertion(target, runtime)),
    action: {
      path: 'accessibility',
      actionName: method,
      verification: { state: 'unverified', reason: 'readback_unsupported' }
    }
  }
}
