/** Renderer per-minute keystroke-to-echo/paint summary (latency telemetry, PR 1.0).
 *  Main writes it to the local trace file only, not the crash-report breadcrumb ring. */
export const TERMINAL_INPUT_LATENCY_BREADCRUMB = 'terminal_input_latency'
