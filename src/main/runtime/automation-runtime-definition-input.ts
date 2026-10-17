import { automationDefinitionContext } from '../../shared/automation-definition-context'
import type { AutomationCreateInput, AutomationUpdateInput } from '../../shared/automations-types'
import type { RuntimeAutomationCreateInput, RuntimeAutomationUpdateInput } from './omni-runtime'

export function buildAutomationCreateInput(
  input: RuntimeAutomationCreateInput,
  target: Pick<AutomationCreateInput, 'projectId' | 'workspaceMode' | 'workspaceId'>
): AutomationCreateInput {
  return {
    ...automationDefinitionContext(input),
    creationKey: input.creationKey,
    createdFromSession: input.createdFromSession,
    name: input.name,
    prompt: input.prompt,
    precheck: input.precheck,
    ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
    launchPreferences: input.launchPreferences,
    agentId: input.agentId,
    runContext: input.runContext,
    sourceContext: input.sourceContext,
    projectId: target.projectId,
    workspaceMode: target.workspaceMode,
    workspaceId: target.workspaceId,
    baseBranch: input.baseBranch,
    setupDecision: input.setupDecision,
    reuseSession: input.reuseSession,
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: input.rrule,
    dtstart: input.dtstart,
    enabled: input.enabled,
    missedRunGraceMinutes: input.missedRunGraceMinutes
  }
}

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}

export function automationUpdateFields(
  updates: RuntimeAutomationUpdateInput
): AutomationUpdateInput {
  const patch: AutomationUpdateInput = {
    ...automationDefinitionContext(updates),
    ...(updates.conversation !== undefined ? { conversation: updates.conversation } : {})
  }
  if (updates.structuredOutput !== undefined) {
    patch.structuredOutput = updates.structuredOutput
  }
  if (updates.launchPreferences !== undefined) {
    patch.launchPreferences = updates.launchPreferences
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'name')) {
    patch.name = updates.name
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'prompt')) {
    patch.prompt = updates.prompt
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'precheck')) {
    patch.precheck = updates.precheck
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'agentId')) {
    patch.agentId = updates.agentId
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'runContext')) {
    patch.runContext = updates.runContext
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'sourceContext')) {
    patch.sourceContext = updates.sourceContext
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'baseBranch')) {
    patch.baseBranch = updates.baseBranch
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'setupDecision')) {
    patch.setupDecision = updates.setupDecision
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'reuseSession')) {
    patch.reuseSession = updates.reuseSession
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'timezone')) {
    patch.timezone = updates.timezone
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'rrule')) {
    patch.rrule = updates.rrule
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'dtstart')) {
    patch.dtstart = updates.dtstart
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'enabled')) {
    patch.enabled = updates.enabled
  }
  if (hasRuntimeAutomationUpdateValue(updates, 'missedRunGraceMinutes')) {
    patch.missedRunGraceMinutes = updates.missedRunGraceMinutes
  }
  return patch
}
