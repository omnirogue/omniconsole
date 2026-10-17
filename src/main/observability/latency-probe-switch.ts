// Kill switch for main-process latency telemetry (`latencyTelemetry` setting, default on).
//
// Why a reader and not the store: observability modules stay decoupled from
// persistence (and from the product-telemetry lane, see index.ts). Main startup
// installs a reader over the settings store; until then — and in tests — the
// default is on, matching the setting's default.

// Why `undefined` is allowed: an unset setting means the default, which is on.
let readEnabled: () => boolean | undefined = () => true

export function setLatencyTelemetryEnabledReader(reader: () => boolean | undefined): void {
  readEnabled = reader
}

/** Never throws: a failing reader counts as the default (on). */
export function isLatencyTelemetryEnabled(): boolean {
  try {
    return readEnabled() !== false
  } catch {
    return true
  }
}

export function _resetLatencyTelemetryEnabledReaderForTests(): void {
  readEnabled = () => true
}
