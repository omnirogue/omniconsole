import type { Automation } from './automations-types'

export type MacDependenceReason = 'project' | 'host' | 'workspace' | 'path' | 'precheck'
export function routineMacDependence(automation: Automation): MacDependenceReason[] {
  const reasons: MacDependenceReason[] = []
  if (automation.projectId || automation.runContext?.projectId) {
    reasons.push('project')
  }
  if (
    (automation.executionTargetType && automation.executionTargetType !== 'local') ||
    (automation.executionTargetId && automation.executionTargetId !== 'local')
  ) {
    reasons.push('host')
  }
  if (automation.workspaceId || automation.workspaceMode === 'existing') {
    reasons.push('workspace')
  }
  if (/\/Users\/|~\/|[A-Za-z]:\\/.test(automation.prompt)) {
    reasons.push('path')
  }
  if (automation.precheck) {
    reasons.push('precheck')
  }
  return reasons
}

export function routineDepartmentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
