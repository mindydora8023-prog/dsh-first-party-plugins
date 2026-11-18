import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONFIG_FILE_MAX_BYTES as LIMIT,
  createConfigFileReader,
  readConfigFile,
} from '../lib/config-file.js';

// A cursor-based, byte-copying fs substitute: zero is EOF, positive counts
// advance the descriptor, and appends preserve all previously visible bytes.
function memoryFile(text, options = {}) {
  let data = Buffer.from(text);
  let position = 0;
  let opened = false;
  const calls = { opens: 0, closes: 0, reads: 0, bytes: 0, buffers: new Set() };
  const info = (size = data.length, regular = true) => ({
    size, isFile: () => regular,
  });
  const io = {
    statSync() {
      if (options.statError) throw new Error('stat failed');
      return info(options.statSize ?? data.length, options.regular ?? true);
    },
    openSync(_file, flags) {
      calls.opens += 1;
      assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      if (options.openError) throw new Error('open failed');
      opened = true;
      return 0;
    },
    fstatSync(fd) {
      assert.equal(fd, 0);
      assert.ok(opened);
      if (options.fstatError) throw new Error('fstat failed');
      return info(options.fdSize ?? data.length, options.fdRegular ?? true);
    },
    readSync(fd, buffer, offset, length, filePosition) {
      assert.equal(fd, 0);
      assert.ok(opened);
      assert.equal(filePosition, null);
      assert.equal(offset, position);
      assert.equal(buffer.length, LIMIT + 1);
      assert.equal(length, LIMIT + 1 - position);
      calls.reads += 1;
      calls.buffers.add(buffer);
      if (options.readError) throw new Error('read failed');
      if (calls.reads === 1 && options.append) {
        data = Buffer.concat([data, Buffer.from(options.append)]);
      }
      const count = Math.min(length, options.chunk ?? length, data.length - position);
      data.copy(buffer, offset, position, position + count);
      position += count;
      calls.bytes += count;
      return count;
    },
    closeSync(fd) {
      assert.equal(fd, 0);
      assert.ok(opened);
      opened = false;
      calls.closes += 1;
      if (options.closeError) throw new Error('close failed');
    },
  };
  return { read: createConfigFileReader(io), calls };
}

function paddedJson(size) {
  return '{}' + ' '.repeat(size - 2);
}

test('real temporary files: JSON, UTF-8, invalid input, missing path and directory', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'task-radar-config-'));
  try {
    const file = join(dir, 'config.json');
    fs.writeFileSync(file, '{"label":"\u4e2d\u6587"}');
    assert.deepEqual(readConfigFile(file), { label: '\u4e2d\u6587' });
    for (const raw of ['', '{broken', '{"a":1} trailing']) {
      fs.writeFileSync(file, raw);
      assert.deepEqual(readConfigFile(file), {});
    }
    fs.writeFileSync(file, 'null');
    assert.equal(readConfigFile(file), null);
    assert.deepEqual(readConfigFile(join(dir, 'missing')), {});
    assert.deepEqual(readConfigFile(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real temporary files enforce byte boundaries including multibyte text', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'task-radar-config-'));
  try {
    const file = join(dir, 'config.json');
    fs.writeFileSync(file, paddedJson(LIMIT));
    assert.deepEqual(readConfigFile(file), {});
    const exact = '{"ok":true}' + ' '.repeat(LIMIT - 11);
    assert.equal(Buffer.byteLength(exact), LIMIT);
    fs.writeFileSync(file, exact);
    assert.deepEqual(readConfigFile(file), { ok: true });
    fs.appendFileSync(file, ' ');
    assert.deepEqual(readConfigFile(file), {});
    fs.writeFileSync(file, JSON.stringify({ text: '\u4e2d'.repeat(LIMIT / 2) }));
    assert.deepEqual(readConfigFile(file), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight rejects oversized and nonregular files without opening or reading', () => {
  for (const options of [{ statSize: LIMIT + 1 }, { regular: false }, { statError: true }]) {
    const fixture = memoryFile('{"ok":true}', options);
    assert.deepEqual(fixture.read('config'), {});
    assert.equal(fixture.calls.opens, 0);
    assert.equal(fixture.calls.reads, 0);
    assert.equal(fixture.calls.buffers.size, 0);
  }
});

test('descriptor recheck rejects replacement and growth before buffer allocation', () => {
  for (const options of [{ fdSize: LIMIT + 1 }, { fdRegular: false }, { fstatError: true }]) {
    const fixture = memoryFile('{"ok":true}', options);
    assert.deepEqual(fixture.read('config'), {});
    assert.equal(fixture.calls.reads, 0);
    assert.equal(fixture.calls.closes, 1);
  }
});

test('short reads accumulate bytes and parse only after actual EOF', () => {
  const fixture = memoryFile('{"text":"\u4e2d\u6587"}', { chunk: 1 });
  assert.deepEqual(fixture.read('config'), { text: '\u4e2d\u6587' });
  assert.equal(fixture.calls.reads, fixture.calls.bytes + 1);
  assert.equal(fixture.calls.buffers.size, 1);
  assert.equal(fixture.calls.closes, 1);
});

test('one-byte reads at the exact limit have sufficient finite iterations for EOF', () => {
  const text = '{"ok":true}' + ' '.repeat(LIMIT - 11);
  const fixture = memoryFile(text, { chunk: 1 });
  assert.deepEqual(fixture.read('config'), { ok: true });
  assert.equal(fixture.calls.reads, LIMIT + 1);
  assert.equal(fixture.calls.bytes, LIMIT);
  assert.equal(fixture.calls.closes, 1);
});

test('growth after fstat consumes at most limit plus one bytes', () => {
  for (const chunk of [1, 4096, LIMIT + 1]) {
    const fixture = memoryFile('{"ok":true}', { append: ' '.repeat(LIMIT * 4), chunk });
    assert.deepEqual(fixture.read('config'), {});
    assert.equal(fixture.calls.bytes, LIMIT + 1);
    assert.ok(fixture.calls.reads <= LIMIT + 1);
    assert.equal(fixture.calls.buffers.size, 1);
    assert.equal(fixture.calls.closes, 1);
  }
});

test('growth remaining within the byte limit is parsed', () => {
  const fixture = memoryFile('{"ok":', { append: 'true}', chunk: 2 });
  assert.deepEqual(fixture.read('config'), { ok: true });
  assert.equal(fixture.calls.closes, 1);
});

test('all opened descriptors close on success, JSON failure and IO failure', () => {
  for (const [text, options] of [
    ['{}', {}], ['invalid', {}], ['{}', { readError: true }],
    ['{}', { fstatError: true }], ['{}', { closeError: true }],
  ]) {
    const fixture = memoryFile(text, options);
    assert.deepEqual(fixture.read('config'), {});
    assert.equal(fixture.calls.closes, 1);
  }
  const fixture = memoryFile('{}', { openError: true });
  assert.deepEqual(fixture.read('config'), {});
  assert.equal(fixture.calls.closes, 0);
});

test('real descriptor observes append between fstat and read without leaking fd', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'task-radar-config-'));
  const file = join(dir, 'config.json');
  let bytes = 0;
  let closes = 0;
  let appended = false;
  try {
    fs.writeFileSync(file, '{"ok":true}');
    const read = createConfigFileReader({
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        if (!appended) {
          appended = true;
          fs.appendFileSync(file, ' '.repeat(LIMIT * 2));
        }
        const count = fs.readSync(fd, buffer, offset, Math.min(length, 17), position);
        bytes += count;
        return count;
      },
      closeSync(fd) {
        closes += 1;
        fs.closeSync(fd);
        assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
      },
    });
    assert.deepEqual(read(file), {});
    assert.equal(bytes, LIMIT + 1);
    assert.equal(closes, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
