export const QUEUE_TRIAGE_ENV = 'JEV_QUEUE_TRIAGE_ENABLED'
export const queueTriageEnabled = (environment = process.env) =>
  environment[QUEUE_TRIAGE_ENV] === '1' &&
  !['JEV_DECISIONS_DISABLED', 'OMNI_STRUCTURED_DECISIONS_KILL'].some(
    (key) => environment[key] && !['0', 'false'].includes(environment[key].toLowerCase())
  )
