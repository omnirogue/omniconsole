const deny = (reason) => ({ allowed: false, reason })
const isObject = (value) => typeof value === 'object' && value !== null
const own = (record, key) =>
  isObject(record) && Object.hasOwn(record, key) ? record[key] : undefined
const text = (value) => typeof value === 'string' && value.length > 0

export function authorizeWorkerStart(request, policy) {
  if (
    !isObject(request) ||
    !isObject(policy) ||
    !text(request.host) ||
    !text(request.account) ||
    !Array.isArray(request.scopes) ||
    !request.scopes.every((scope) => typeof scope === 'string')
  ) {
    return deny('malformed-request')
  }
  const host = own(policy.hosts, request.host)
  if (!isObject(host)) {
    return deny('unknown-host')
  }
  if (host.reachability === 'unverifiable') {
    return deny('host-unverifiable')
  }
  if (host.reachability === 'exited') {
    return deny('host-exited')
  }
  const account = own(host.accounts, request.account)
  if (!isObject(account)) {
    return deny('unknown-account')
  }
  if (account.verified !== true) {
    return deny('account-unverified')
  }
  const granted = Array.isArray(account.scopes) ? account.scopes : []
  if (!request.scopes.every((scope) => granted.includes(scope))) {
    return deny('scope-not-granted')
  }
  if (isObject(request.action) && request.action.needsApproval === true) {
    const approval = request.approval
    if (!isObject(approval) || approval.instanceId !== request.action.id || !text(approval.by)) {
      return deny('approval-required')
    }
  }
  return { allowed: true, reason: 'ok' }
}
