# DSH First-Party Plugins

[简体中文](README.md)

Eight plugins for DeepSeek Harness (DSH). The repository contains plugins developed in this workspace and adaptations of upstream code. Upstream code and color palettes retain their original attribution and MIT notices.

| Plugin | Version | Features | Source |
| --- | --- | --- | --- |
| [archived-sessions](plugins/archived-sessions/README.md) | 0.8.0 | Filter archived sessions, preview cleanup, export an inventory, and optionally recover sessions from a recycle bin | Developed in this workspace |
| [session-meter](plugins/session-meter/README.md) | 0.5.1 | Session and per-request cost estimates, CSV/JSON export, a local daily ledger, and optional account balance | Developed in this workspace, with external pricing data fetched at runtime |
| [filekit](plugins/filekit/README.md) | 0.4.0 | Read CSV, TSV, DOCX, XLSX, PPTX, and PDF text, browse document outlines, and search full text | [DeepSeek compatibility modules](plugins/filekit/THIRD_PARTY_NOTICES.md) |
| [github](plugins/github/README.md) | 0.3.0 | Browse paginated GitHub data and CI logs, create and merge pull requests, update issues, and submit reviews | [DeepSeek compatibility modules and an original branch icon](plugins/github/THIRD_PARTY_NOTICES.md) |
| [ops-lite](plugins/ops-lite/README.md) | 0.3.0 | Read multiple files within configurable limits, find literal text, and inspect directory trees | [Adapted from DeepSeek and dsh-ops](plugins/ops-lite/THIRD_PARTY_NOTICES.md) |
| [next-say](plugins/next-say/README.md) | 0.4.0 | Predict the next prompt, complete drafts from local history, recall history with arrow keys, and set a daily prediction budget | [Helper logic from dsh-prompt-predict](plugins/next-say/THIRD_PARTY_NOTICES.md) |
| [task-radar](plugins/task-radar/README.md) | 0.4.0 | In-app notifications, Windows Toast, quiet hours, and generic webhooks | [Adapted from the Pasumao notification engine](plugins/task-radar/THIRD_PARTY_NOTICES.md) |
| [mcp-on-demand](plugins/mcp-on-demand/README.md) | 0.4.0 | Load MCP servers on demand, search the catalog, probe tools, and check server health | Developed in this workspace |

See the [source audit](docs/source-audit.md) for attribution and the [release notes and checks](RELEASE-CHECK.md) for the project history.

## Installation

You need Node.js 22 or later and DeepSeek Harness. task-radar requires DSH 0.2.2-rc.3 or a later compatible 0.2.x release. Check each plugin's manifest and README for its host requirements. Before upgrading or restarting the host, check for active sessions.

### Install with the CLI

Download or clone this repository and run these commands from its root. Replace `/path/to/profile` with the path to an existing DSH profile directory or its `package.json`. Quote paths that contain spaces on Windows or Linux.

```sh
npm run install-plugins -- --list
npm run install-plugins -- --profile "/path/to/profile" --plugins filekit,next-say --dry-run
npm run install-plugins -- --profile "/path/to/profile" --plugins filekit,next-say
npm run install-plugins -- --profile "/path/to/profile" --all
npm run install-plugins -- --profile "/path/to/profile" --uninstall filekit,next-say
```

Run `npm run install-plugins` in a terminal to enter the profile path and select plugins interactively. Enter plugin numbers to toggle them, then press Enter to confirm. The installer writes absolute `link:` paths to the local plugin directories by default. You can also pass `--link` explicitly. Keep the checkout in place while the profile uses those links.

The CLI saves a timestamped `package.json.bak.<timestamp>` beside the profile manifest before each write and prints its path. To restore the complete profile from that snapshot, run `npm run install-plugins -- --rollback "/path/to/profile/package.json.bak.<timestamp>"` with the actual backup path. Dry runs and operations that leave the profile unchanged produce no backups.

Stop the host before writing configuration. After installing, uninstalling, or rolling back, run the package manager supplied with DSH in the profile directory to sync dependencies. Then restart the host and refresh the page.

### Install manually

Use the local package option in DSH's plugin manager, or stop the host and merge the entries below into the profile's `package.json`. Replace the example paths with absolute paths to your checkout and keep the profile's existing entries.

```json
{
  "dependencies": {
    "dsh-plugin-filekit": "link:/ABSOLUTE/PATH/dsh-first-party-plugins/plugins/filekit",
    "dsh-plugin-next-say": "link:/ABSOLUTE/PATH/dsh-first-party-plugins/plugins/next-say"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-filekit", "dsh-plugin-next-say"]
    }
  }
}
```

Each plugin can be installed independently. Use the package name from its manifest and sync dependencies with DSH's package manager before restarting the host.

The plugins have zero third-party npm runtime dependencies. DSH supplies host services and browser modules. The `private: true` flag prevents accidental publication to npm. The source is available under the MIT license.

## Verification

```sh
npm test
npm run check
```

The default test run uses offline fixtures and stubs for GitHub and session data. Each plugin suite runs in a subprocess with a 60-second timeout. Set `DSH_HOST_CHECKOUT` to a compatible host checkout containing `node_modules/@deepseek-ai` to run the optional host contract tests. Set `DSH_INSTALL_DIR` to the installed `@deepseek-ai/dsh` package directory to run task-radar's installed-host integration test. The test runner reports any skips.

GitHub Actions runs the suite on Windows and Linux with Node.js 22 and 24. It also checks the generated clients and dictionaries, filekit's OOXML fixtures, and task-radar's SVG and PNG icons against their sources. [Workflow runs](https://github.com/mindydora8023-prog/dsh-first-party-plugins/actions)

## Release packages

Pushing a `v*` tag runs the same test matrix before publishing a GitHub Release with eight `.tgz` archives, `SHA256SUMS.txt`, and `manifest.json`. The manifest records each package's version, filename, size in bytes, and SHA-256 digest.

```sh
node tools/pack-release.mjs
node tools/pack-release.mjs --check
```

The first command writes the release files to `dist/releases/`. The second rebuilds the archives and verifies the local release files.

## Plugin behavior and local data

archived-sessions automatically cleans up archives older than five days by default. Review that setting after installation. GitHub write tools act on your account, and next-say can incur charges when it calls its configured prediction model. See each plugin's README for its settings and data locations.

Host bundles, personal sessions, account settings, credentials, attachments, logs, and external pricing snapshots stay outside the distribution. Store runtime data in the user state directory or a directory you explicitly configure.

## License

Local contributions are licensed under the [MIT License](LICENSE), copyright `dsh-plugins contributors`. See each plugin's `THIRD_PARTY_NOTICES.md` and `licenses/` directory, where present, for the full upstream notices and licenses.
