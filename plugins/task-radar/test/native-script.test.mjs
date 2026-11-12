import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { createToastSender } from '../lib/index.js';

// Parse only: no WinRT notification object is created and no toast is displayed.
test('generated Toast code passes the real Windows PowerShell parser', { skip: process.platform !== 'win32' }, () => {
  let captured;
  const sender = createToastSender({
    platform: 'win32',
    spawnProcess(executable, args, options) {
      captured = { executable, args, options };
      return new EventEmitter();
    },
  });
  sender({ logger: { warn() {} } }, { toast: { persistent: true, iconPath: '' } }, { title: 'Parser fixture', body: 'No notification is sent' });
  const parser = "$tokens=$null; $errors=$null; $source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:TASK_RADAR_PARSE_SOURCE)); [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if($errors.Count){[Console]::Error.WriteLine(($errors | ForEach-Object {$_.Message}) -join '; '); exit 2}; Write-Output 'valid'";
  const encodedParser = Buffer.from(parser, 'utf16le').toString('base64');
  function parse(source) {
    return spawnSync(captured.executable || join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedParser], {
      env: { ...captured.options.env, TASK_RADAR_PARSE_SOURCE: source },
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
  }
  const actual = parse(captured.args.at(-1));
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  assert.match(actual.stdout, /valid/);
  const broken = Buffer.from('$xml = "<toast activationType="background">"', 'utf16le').toString('base64');
  const negative = parse(broken);
  assert.equal(negative.status, 2, 'the parser must catch the former unescaped-quote regression');
});
