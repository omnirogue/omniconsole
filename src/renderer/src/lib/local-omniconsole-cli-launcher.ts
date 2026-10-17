import { setLocalOmniConsoleCliLauncher } from '../../../shared/omniconsole-cli-launcher'

/**
 * Ask main once for the OmniConsole CLI launcher on this host so local launch
 * commands (Attention favourites, Queue next session, the agent catalog) name it by
 * absolute path instead of trusting the login shell's PATH. A browser client has no
 * bundled CLI and keeps the bare name.
 */
export function installLocalOmniConsoleCliLauncherFromPreload(): void {
  const getter = window.api?.app?.getLocalCliLauncher
  if (typeof getter !== 'function') {
    setLocalOmniConsoleCliLauncher(null)
    return
  }
  void getter()
    .then((launcher) => {
      setLocalOmniConsoleCliLauncher(
        typeof launcher === 'string' && launcher.trim() ? launcher : null
      )
    })
    .catch(() => setLocalOmniConsoleCliLauncher(null))
}
