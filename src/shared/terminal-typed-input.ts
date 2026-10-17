/**
 * Whether terminal input carries a key the person pressed, as opposed to xterm's own replies (query
 * answers, focus and mouse reports). Shared by the renderer (Keep going stops on typing) and main
 * (typing in a terminal settles text a refused prompt left in its input box).
 */

/** Index after one escape sequence starting at `index` (CSI, SS3, or a two-byte escape). */
export function skipTerminalEscape(data: string, index: number): number {
  if (data[index + 1] === '[') {
    let end = index + 2
    while (end < data.length && !/[@-~]/.test(data[end]!)) {
      end += 1
    }
    return end + 1
  }
  return index + (data[index + 1] === 'O' ? 3 : 2)
}

/** Index after an OSC/DCS/APC/PM/SOS string, which ends at BEL or ST (ESC backslash). */
function skipStringSequence(data: string, index: number): number {
  let end = index + 2
  while (end < data.length && data[end] !== '\x07' && !data.startsWith('\x1b\\', end)) {
    end += 1
  }
  return end + (data[end] === '\x07' ? 1 : 2)
}

/**
 * True when `data` carries a key the person pressed (text, Enter, Backspace, Ctrl-C, a lone Esc,
 * a paste), not only escape sequences: xterm's query replies, focus and mouse reports are never
 * the person typing.
 */
export function isTypedTerminalInput(data: string): boolean {
  let index = 0
  while (index < data.length) {
    if (data[index] !== '\x1b') {
      return true
    }
    const next = data[index + 1]
    if (next === undefined || next === '\r' || next === '\x1b') {
      return true
    }
    if (next === '[' && data[index + 2] === 'M') {
      // X10 mouse report: three raw bytes follow the CSI M.
      index += 6
    } else if (']P_^X'.includes(next)) {
      index = skipStringSequence(data, index)
    } else {
      index = skipTerminalEscape(data, index)
    }
  }
  return false
}
