/**
 * filekit configuration: hard caps and toggles.
 *
 * Every bound here exists so one tool call cannot flood the model context.
 * A profile may tighten them; raising them past the documented maxima is
 * ignored rather than trusted.
 */

import { statePath } from './state-dir.js'

export const MAX_FILES = 32
export const MAX_LIMIT = 2000
export const MAX_LINE_LENGTH = 2000
export const MAX_OUTPUT_BYTES = 50 * 1024
export const MAX_CALL_BYTES = 200 * 1024
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_SCAN_BYTES = 64 * 1024 * 1024
export const DOC_MAX_LIMIT = 1000
export const MAX_PDF_PAGES = 32
export const MAX_CELL_LENGTH = 500

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function int(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min || i > max) return fallback
  return i
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * @param raw Plugin config from cordis.patch.yml (may be undefined).
 * @param dirs { pluginDir, profileDir, home }
 */
export function readConfig(raw, dirs) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    maxFiles: int(src.maxFiles, MAX_FILES, 1, MAX_FILES),
    defaultLimit: int(src.defaultLimit, 400, 1, MAX_LIMIT),
    maxLimit: int(src.maxLimit, MAX_LIMIT, 1, MAX_LIMIT),
    maxLineLength: int(src.maxLineLength, MAX_LINE_LENGTH, 80, MAX_LINE_LENGTH),
    maxOutputBytes: int(src.maxOutputBytes, MAX_OUTPUT_BYTES, 4096, 4 * 1024 * 1024),
    callMaxBytes: int(src.callMaxBytes, MAX_CALL_BYTES, 8192, 16 * 1024 * 1024),
    maxFileBytes: int(src.maxFileBytes, MAX_FILE_BYTES, 64 * 1024, 256 * 1024 * 1024),
    scanMaxBytes: int(src.scanMaxBytes, MAX_SCAN_BYTES, 1024 * 1024, 512 * 1024 * 1024),
    docDefaultLimit: int(src.docDefaultLimit, 200, 1, DOC_MAX_LIMIT),
    docMaxLimit: int(src.docMaxLimit, DOC_MAX_LIMIT, 1, DOC_MAX_LIMIT),
    maxCellLength: int(src.maxCellLength, MAX_CELL_LENGTH, 40, 4000),
    pdfDefaultPages: int(src.pdfDefaultPages, 10, 1, MAX_PDF_PAGES),
    pdfMaxPages: int(src.pdfMaxPages, MAX_PDF_PAGES, 1, MAX_PDF_PAGES),
    denyCredentialReads: bool(src.denyCredentialReads, true),
    // Default goes to the per-user state directory, NOT the plugin's source tree:
    // that tree is mirrored to git and may be read-only (see lib/state-dir.js).
    statusFile:
      src.statusFile === false
        ? false
        : text(src.statusFile, statePath('filekit', 'filekit-status.json')),
    dirs,
  }
}
