const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function rollupUsage(attempts) {
  if (!Array.isArray(attempts)) {
    throw new TypeError('attempts must be an array')
  }
  const reported = attempts.filter((a) => count(a.inputTokens) && count(a.outputTokens))
  const partialTokens = {
    input: reported.reduce((sum, a) => sum + a.inputTokens, 0),
    output: reported.reduce((sum, a) => sum + a.outputTokens, 0),
    reportedAttempts: reported.length
  }
  const everyCost = attempts.every((a) => count(a.costUsd))
  return {
    attempts: attempts.length,
    succeeded: attempts.filter((a) => a.outcome === 'succeeded').length,
    failed: attempts.filter((a) => a.outcome === 'failed').length,
    retries: attempts.filter((a) => a.retryOf !== undefined).length,
    wallClockMs:
      attempts.length === 0
        ? 0
        : Math.max(...attempts.map((a) => a.endedAtMs)) -
          Math.min(...attempts.map((a) => a.startedAtMs)),
    activeMs: attempts.reduce((sum, a) => sum + (a.endedAtMs - a.startedAtMs), 0),
    tokens:
      reported.length === attempts.length
        ? { input: partialTokens.input, output: partialTokens.output }
        : 'unknown',
    partialTokens,
    costUsd: everyCost
      ? Math.round(attempts.reduce((sum, a) => sum + a.costUsd, 0) * 1e6) / 1e6
      : 'unknown'
  }
}
