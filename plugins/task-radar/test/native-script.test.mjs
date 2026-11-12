import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createToastSender } from '../lib/index.js';

// Parse only: no WinRT notification object is created and no toast is displayed.
test('generated Toast code passes the real Windows PowerShell parser', { skip: process.platform !== 'win32' }, () => {
  let captured;
  createToastSender({ platform: 'win32', spawnProcess(executable, args, options) {
    captured = { executable, args, options };
    return new EventEmitter();
  } })({ logger: { warn() {} } }, { toast: { persistent: true, iconPath: '' } }, { title: 'Parser fixture', body: 'No notification is sent' });
  // CI images can start Windows PowerShell cold. Use one bounded process for
  // both controls, with a larger test-only budget; production remains 10s.
  const parser = String.raw`
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
$cases = @(
  @{ Source = $env:TASK_RADAR_PARSE_SOURCE; Valid = $true },
  @{ Source = $env:TASK_RADAR_PARSE_BROKEN; Valid = $false }
)
foreach ($case in $cases) {
  $tokens = $null; $errors = $null
  $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($case.Source))
  [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  if ($case.Valid -and $errors.Count) { [Console]::Error.WriteLine([string]$errors[0].Message); exit 2 }
  if (-not $case.Valid -and -not $errors.Count) { [Console]::Error.WriteLine('negative control was accepted'); exit 3 }
}
[Console]::Out.WriteLine('valid; negative-control-verified')
`;
  const broken = Buffer.from('$xml = "<toast activationType="background">"', 'utf16le').toString('base64');
  const actual = spawnSync(captured.executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], {
    env: { ...captured.options.env, TASK_RADAR_PARSE_SOURCE: captured.args.at(-1), TASK_RADAR_PARSE_BROKEN: broken },
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', windowsHide: true,
  });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  assert.match(actual.stdout, /valid; negative-control-verified/);
});
