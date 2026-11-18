import * as fs from 'node:fs';

export const CONFIG_FILE_MAX_BYTES = 256 * 1024;
const READ_CAPACITY = CONFIG_FILE_MAX_BYTES + 1;

function acceptableFile(info) {
  return info.isFile() && Number.isSafeInteger(info.size) &&
    info.size >= 0 && info.size <= CONFIG_FILE_MAX_BYTES;
}

/** The IO seam uses the same synchronous signatures and semantics as node:fs. */
export function createConfigFileReader(io = fs) {
  return function readConfigFile(file) {
    let fd;
    try {
      // Avoid opening known directories/devices/FIFOs or allocating for large files.
      if (!acceptableFile(io.statSync(file))) return {};
      // Nonblocking open also handles a regular-file-to-FIFO replacement race.
      fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      if (!acceptableFile(io.fstatSync(fd))) return {};
      const buffer = Buffer.alloc(READ_CAPACITY);
      let total = 0;
      // Even one-byte short reads have an explicit finite iteration budget.
      for (let attempt = 0; attempt < READ_CAPACITY; attempt += 1) {
        const remaining = READ_CAPACITY - total;
        const count = io.readSync(fd, buffer, total, remaining, null);
        if (!Number.isInteger(count) || count < 0 || count > remaining) return {};
        if (count === 0) return JSON.parse(buffer.toString('utf8', 0, total));
        total += count;
        if (total > CONFIG_FILE_MAX_BYTES) return {};
      }
      return {};
    } catch {
      return {};
    } finally {
      if (fd !== undefined) {
        try { io.closeSync(fd); } catch { /* Best effort after every opened fd. */ }
      }
    }
  };
}

export const readConfigFile = createConfigFileReader();
