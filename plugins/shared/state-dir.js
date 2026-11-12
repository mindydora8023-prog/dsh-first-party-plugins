/**
 * Where a plugin writes its runtime state.
 *
 * WHY THIS IS SHARED
 * Every plugin used to default its status file to `<pluginDir>/<name>-status.json`
 * -- inside the SOURCE TREE. Measured 2026-10-26: seven plugins had left runtime
 * files there, including gmail's `credentials.json` (a real app password) sitting
 * next to the code. Concrete consequences, all observed:
 *
 *   1. The directory is mirrored to a git repository, so the sync tool had to
 *      carry a shape-based filter (`*-status.json`) purely to keep runtime noise
 *      and secrets out. A filter is a workaround for the wrong default.
 *   2. Running the test suite could overwrite the file the LIVE host wrote.
 *      ops-lite proved it: its `ops-lite-status.json` recorded a pid and a
 *      `home` under `%TEMP%`, i.e. a test run had written it, because that plugin
 *      ignored `statusFile` entirely and always used the source path.
 *   3. A `link:` plugin's source directory may be read-only or on a network
 *      share; runtime state does not belong there.
 *
 * THE RULE
 *   - `statusFile: false` disables writing (tests rely on this).
 *   - `statusFile: '<path>'` uses that path verbatim.
 *   - otherwise the file goes to the per-user state directory below.
 *
 * RESOLUTION ORDER for the state root, first usable wins:
 *   1. `DSH_PLUGIN_STATE_DIR` -- explicit override, used by tests and by anyone
 *      who wants state on another volume.
 *   2. `LOCALAPPDATA` (Windows) / `XDG_STATE_HOME` (elsewhere) -> a `dsh-plugins`
 *      subdirectory. This is the normal case on the target machine.
 *   3. `os.tmpdir()` as the last resort, so a plugin never fails to load merely
 *      because no state directory could be derived. The fallback is reported in
 *      the status file so it is visible rather than silent.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** The directory name used for every plugin's state, under the chosen root. */
export const STATE_DIR_NAME = 'dsh-plugins'

/**
 * Resolve the root directory that holds every plugin's runtime state.
 * @returns {string} an absolute directory path (not created here)
 */
export function stateRoot() {
  const override = process.env['DSH_PLUGIN_STATE_DIR']
  if (typeof override === 'string' && override.trim() !== '') return override.trim()

  const localAppData = process.env['LOCALAPPDATA']
  if (typeof localAppData === 'string' && localAppData.trim() !== '') {
    return join(localAppData.trim(), STATE_DIR_NAME)
  }
  const xdg = process.env['XDG_STATE_HOME']
  if (typeof xdg === 'string' && xdg.trim() !== '') return join(xdg.trim(), STATE_DIR_NAME)

  try {
    const home = homedir()
    if (typeof home === 'string' && home !== '') return join(home, '.local', 'state', STATE_DIR_NAME)
  } catch {
    /* fall through to the temp directory */
  }
  return join(tmpdir(), STATE_DIR_NAME)
}

/**
 * Absolute path for one plugin's runtime file.
 * @param {string} plugin the plugin name, e.g. `filekit`
 * @param {string} file the file name, e.g. `filekit-status.json`
 * @returns {string}
 */
export function statePath(plugin, file) {
  return join(stateRoot(), plugin, file)
}

/**
 * A one-line description of where state goes, for the status file itself.
 *
 * Recorded so "why is my status file not where I expected?" is answerable from
 * the file, instead of requiring the reader to know this module's rules.
 * @returns {object} `{ root, override }`; `override` says the env var was used.
 */
export function stateProvenance() {
  const override = typeof process.env['DSH_PLUGIN_STATE_DIR'] === 'string'
    && process.env['DSH_PLUGIN_STATE_DIR'].trim() !== ''
  return { root: stateRoot(), override }
}
