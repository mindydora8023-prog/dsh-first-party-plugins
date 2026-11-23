/**
 * Bounded synchronous JSON config reader backed by shared `lib/json-store.js`.
 * Preserves the `createConfigFileReader(io)` test seam for unit tests.
 *
 * ASCII only.
 */

import * as fs from 'node:fs';

import { DEFAULT_MAX_JSON_BYTES, readJsonFileBoundedSync } from './json-store.js';

export const CONFIG_FILE_MAX_BYTES = DEFAULT_MAX_JSON_BYTES;

/** The IO seam uses the same synchronous signatures and semantics as node:fs. */
export function createConfigFileReader(io = fs) {
  return function readConfigFile(file) {
    return readJsonFileBoundedSync(file, {
      maxBytes: CONFIG_FILE_MAX_BYTES,
      fallback: {},
      io,
    });
  };
}

export const readConfigFile = createConfigFileReader();
