/**
 * Windows PowerShell WinRT Toast sender adapted from Pasumao/dsh-plugin-notify.
 * Copyright (c) 2026 Pasumao. MIT; see ../THIRD_PARTY_NOTICES.md and ../licenses/.
 *
 * Precomputes the UTF-16LE Base64 script once at module load, bounds concurrent
 * PowerShell processes, unrefs spawned children, and cleans them up on unload.
 *
 * ASCII only.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOAST_PROCESS_TIMEOUT_MS = 10000;
export const MAX_CONCURRENT_TOASTS = 2;

const DEFAULT_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
function XmlEscape([string]$s) { return [System.Security.SecurityElement]::Escape($s) }
$title = [string]$env:TR_TITLE
$body = [string]$env:TR_BODY
$location = [string]$env:TR_LOCATION
$icon = [string]$env:TR_ICON
$persist = [string]$env:TR_PERSIST
$duration = [string]$env:TR_DURATION
$aumid = [string]$env:TR_AUMID
$seconds = 8
if ($duration -match '^\d+$') { $seconds = [int]$duration }
if ($seconds -lt 3) { $seconds = 3 }
if ($seconds -gt 30) { $seconds = 30 }
$durationAttr = ''
if ($persist -ne '1') {
  $banner = 'short'
  if ($seconds -gt 10) { $banner = 'long' }
  $durationAttr = ' duration="' + $banner + '"'
}
$iconPart = ''
if ($icon -and (Test-Path -LiteralPath $icon)) {
  $u = [System.Uri]::new($icon).AbsoluteUri
  $iconPart = '<image placement="appLogoOverride" src="' + (XmlEscape $u) + '" hint-crop="circle"/>'
}
$locPart = ''
if ($location) { $locPart = '<text>' + (XmlEscape $location) + '</text>' }
$scenario = ''
if ($persist -eq '1') { $scenario = ' scenario="reminder"' }
$xmlText = '<toast' + $scenario + $durationAttr + ' activationType="background"><visual><binding template="ToastGeneric">' + $iconPart + '<text>' + (XmlEscape $title) + '</text><text>' + (XmlEscape $body) + '</text>' + $locPart + '</binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($persist -ne '1') { $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($seconds) }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`.trim();

/** Precomputed once at module load so every toast avoids re-encoding the script. */
export const ENCODED_TOAST_SCRIPT = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');

function defaultPowershellPath(env = process.env) {
  const windir = env.windir || env.WINDIR || 'C:\\Windows';
  return join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function defaultIconPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');
}

function sanitizedEnv(extra, parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) continue;
    env[key] = value;
  }
  return Object.assign(env, extra);
}

function toastSeconds(toast) {
  const n = toast && Number(toast.durationMs);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.max(3, Math.min(30, Math.round(n / 1000)));
}

/** Inject process boundaries so tests never start PowerShell or display a toast. */
export function createToastSender({
  platform = process.platform,
  spawnProcess = spawn,
  fileExists = existsSync,
  environment = () => process.env,
  maxConcurrent = MAX_CONCURRENT_TOASTS,
  signal,
} = {}) {
  const active = new Set();
  const cap = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : MAX_CONCURRENT_TOASTS;

  const stopAll = () => {
    for (const child of active) {
      try {
        if (typeof child.kill === 'function') child.kill('SIGKILL');
      } catch { /* ignore */ }
    }
    active.clear();
  };

  if (signal) {
    if (signal.aborted) stopAll();
    else signal.addEventListener('abort', stopAll, { once: true });
  }

  return function sendToast(ctx, cfg, payload) {
    if (platform !== 'win32') return false;
    if (signal && signal.aborted) return false;
    const warn = (message) => {
      if (ctx.logger && ctx.logger.warn) ctx.logger.warn(message);
    };
    if (active.size >= cap) {
      warn('task-radar: toast skipped (too many concurrent toast processes)');
      return false;
    }
    try {
      const parentEnv = environment();
      const ps = defaultPowershellPath(parentEnv);
      const iconOverride = cfg.toast && typeof cfg.toast.iconPath === 'string' ? cfg.toast.iconPath.trim() : '';
      const iconCandidate = iconOverride !== '' ? iconOverride : defaultIconPath();
      const icon = fileExists(iconCandidate) ? iconCandidate : '';
      const child = spawnProcess(
        ps,
        ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', ENCODED_TOAST_SCRIPT],
        {
          env: sanitizedEnv({
            TR_TITLE: payload.title,
            TR_BODY: payload.body,
            TR_LOCATION: payload.location || '',
            TR_ICON: icon,
            TR_PERSIST: cfg.toast && cfg.toast.persistent ? '1' : '',
            TR_DURATION: String(toastSeconds(cfg.toast)),
            TR_AUMID: DEFAULT_AUMID,
          }, parentEnv),
          windowsHide: true,
          stdio: 'ignore',
          timeout: TOAST_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      active.add(child);
      if (typeof child.unref === 'function') child.unref();
      child.once('error', (error) => {
        active.delete(child);
        warn('task-radar: toast process error: ' + String(error));
      });
      child.once('exit', (code, exitSignal) => {
        active.delete(child);
        if (exitSignal || (code !== null && code !== 0)) {
          warn('task-radar: toast process exited: ' + String(code) + (exitSignal ? ' (' + exitSignal + ')' : ''));
        }
      });
      return true;
    } catch (error) {
      warn('task-radar: failed to launch toast: ' + String(error));
      return false;
    }
  };
}

const defaultToastSender = createToastSender();
export function fireToast(ctx, cfg, payload) {
  return defaultToastSender(ctx, cfg, payload);
}
