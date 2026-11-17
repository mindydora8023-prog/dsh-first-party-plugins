/**
 * Termination watchdog for the one loop that once hung the whole machine.
 *
 * `clearChildren` used to be `while (node.firstChild !== null)`. A test double
 * without a `firstChild` property made that condition permanently true, so a test
 * run spun at 100% of one CPU core for twenty minutes and never exited.
 *
 * The obvious defence -- `node --test --test-timeout` -- does NOT work here, and
 * that was measured: a test with a synchronous `for (;;)` kept spinning under
 * `--test-timeout=2000` until it was killed by hand, because a blocked event loop
 * never runs the timer that would report the timeout. `--test-timeout` only
 * covers asynchronous waits.
 *
 * So the protection has to be:
 *   1. a bounded loop in the production code (see `clearChildren`), and
 *   2. this test, which calls it in a CHILD process that the parent can kill.
 * If the bound ever regresses, the suite fails within seconds with a message
 * instead of pinning a core.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const GHOST = new URL('../lib/ghost.js', import.meta.url);

/** Run one snippet in a fresh process; resolve `code`, or 'timeout'. */
async function runIsolated(source, timeoutMs) {
  // `stdio: 'ignore'`: nothing to capture, and it keeps this working under a
  // sandbox that denies piped stdio.
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  let timer;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const outcome = await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  // Clear it: an unsettled 5 s timer would keep the test process alive that long
  // for no reason (measured: the suite gained a 5 s tail before this line).
  clearTimeout(timer);
  if (outcome === 'timeout') {
    // A synchronous spin cannot observe signals it never yields to; SIGKILL is
    // the only option that is guaranteed to land.
    child.kill('SIGKILL');
  }
  await closed;
  return outcome;
}

test('clearing children terminates on a node with neither children nor firstChild', async () => {
  const outcome = await runIsolated(
    `import { clearChildren } from ${JSON.stringify(GHOST.href)};
     clearChildren({ removeChild() {} });`,
    5000,
  );
  assert.notEqual(
    outcome,
    'timeout',
    'clearChildren did not terminate: the child-removal loop lost its bound and would burn a CPU core',
  );
  assert.equal(outcome, 0);
});

test('both child-removal branches terminate with non-progressing host objects', async () => {
  const outcome = await runIsolated(
    `import { clearChildren } from ${JSON.stringify(GHOST.href)};
     for (const node of [
       { children: { length: Infinity, 0: {} } },
       { children: { length: 1, 0: {} } },
       { firstChild: {} },
     ]) {
       let calls = 0;
       node.removeChild = () => { calls += 1; };
       clearChildren(node);
       if (calls > 64 || calls === 0) throw new Error('removal bound violated');
     }`,
    5000,
  );
  assert.notEqual(outcome, 'timeout', 'clearChildren did not terminate on a non-progressing collection');
  assert.equal(outcome, 0);
});

test('the watchdog kills and reaps a synchronous spin', async () => {
  assert.equal(await runIsolated('for (;;) {}', 150), 'timeout');
});

test('clearing children removes what a node does expose', async () => {
  const outcome = await runIsolated(
    `import { clearChildren } from ${JSON.stringify(GHOST.href)};
     const kids = [{ id: 1 }, { id: 2 }];
     const node = {
       children: kids,
       removeChild(child) {
         const at = kids.indexOf(child);
         if (at === -1) throw new Error('removed an unknown child');
         kids.splice(at, 1);
       },
     };
     clearChildren(node);
     if (node.children.length !== 0) throw new Error('children not cleared');`,
    5000,
  );
  assert.notEqual(outcome, 'timeout', 'clearing a node that does expose children must terminate');
  assert.equal(outcome, 0);
});
