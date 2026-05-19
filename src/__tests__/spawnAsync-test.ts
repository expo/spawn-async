import assert from 'assert';
import path from 'path';

import spawnAsync, { SpawnOptions, SpawnPromise, SpawnResult } from '../spawnAsync';

it(`receives output from completed processes`, async () => {
  let result = await spawnAsync('echo', ['hi']);
  expect(typeof result.pid).toBe('number');
  expect(result.stdout).toBe('hi\n');
  expect(result.stderr).toBe('');

  expect(result.output[0]).toBe(result.stdout);
  expect(result.output[1]).toBe(result.stderr);

  expect(result.status).toBe(0);
  expect(result.signal).toBe(null);
});

it(`throws errors when processes return non-zero exit codes`, async () => {
  let didThrow = false;
  try {
    await spawnAsync('false');
  } catch (e: any) {
    didThrow = true;
    expect(e.message).toBe(`false exited with non-zero code: 1`);
    expect(typeof e.pid).toBe('number');
    expect(e.status).toBe(1);
    expect(e.signal).toBe(null);
  }
  expect(didThrow).toBe(true);
});

it(`includes command arguments in the error message`, async () => {
  await expect(() => spawnAsync('false', ['dummy'])).rejects.toThrowError(`false dummy exited`);
});

it(`returns when processes are killed with signals with non-zero exit codes`, async () => {
  let didThrow = false;
  try {
    await spawnAsync(path.join(__dirname, 'signal-self.sh'));
  } catch (e: any) {
    didThrow = true;
    expect(typeof e.pid).toBe('number');
    expect(e.status).toBe(null);
    expect(e.signal).toBe('SIGKILL');
  }
  expect(didThrow).toBe(true);
});

it(`throws errors when processes don't exist`, async () => {
  let didThrow = false;
  try {
    await spawnAsync('nonexistent-program');
  } catch (e: any) {
    didThrow = true;
    expect(e.pid).not.toBeDefined();
    expect(e.code).toBe('ENOENT');
    expect(e.status).toBe(null);
    expect(e.signal).toBe(null);
  }
  expect(didThrow).toBe(true);
});

it(`exposes the child process through a property named "child"`, async () => {
  let spawnTask = spawnAsync('echo', ['hi']);
  let childProcess = spawnTask.child;
  expect(childProcess).toBeDefined();

  let result = await spawnTask;
  expect(result.pid).toBe(childProcess.pid);
});

it(`runs extra listeners added to the child process`, async () => {
  let spawnTask = spawnAsync('echo', ['hi']);
  let mockExitListener = jest.fn();
  let mockCloseListener = jest.fn();
  spawnTask.child.on('exit', mockExitListener);
  spawnTask.child.on('close', mockCloseListener);

  await spawnTask;
  expect(mockExitListener).toHaveBeenCalledTimes(1);
  expect(mockCloseListener).toHaveBeenCalledTimes(1);
});

it(`runs extra error listeners added to the child process when there is an error`, async () => {
  let spawnTask = spawnAsync('nonexistent-program');
  let mockErrorListener = jest.fn();
  spawnTask.child.on('error', mockErrorListener);

  await expect(spawnTask).rejects.toThrowError();
  expect(mockErrorListener).toHaveBeenCalledTimes(1);
});

it(`returns empty strings when ignoring stdio`, async () => {
  let result = await spawnAsync('echo', ['hi'], { ignoreStdio: true });
  expect(typeof result.pid).toBe('number');
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');

  expect(result.output[0]).toBe(result.stdout);
  expect(result.output[1]).toBe(result.stderr);

  expect(result.status).toBe(0);
  expect(result.signal).toBe(null);
});

it(`returns even if stdout is open when ignoring stdio`, async () => {
  // Without ignoring stdio, the promise will never resolve as stdout remains open indefinitely
  let sourceTask = spawnAsync('yes', [], { ignoreStdio: true });
  expect(sourceTask.child.listenerCount('exit')).toBe(1);
  expect(sourceTask.child.listenerCount('close')).toBe(0);

  // Create a sink that keeps the source's stdout open even after the source process exits
  let sinkTask = spawnAsync('cat');
  assert(sourceTask.child.stdout && sinkTask.child.stdin);
  sourceTask.child.stdout.pipe(sinkTask.child.stdin);
  sinkTask.child.stdin.cork();

  // Allow the source's stdout to buffer with a short delay
  await new Promise((resolve) => setTimeout(resolve, 5));

  // The source's stdout stays open even after killing the process
  sourceTask.child.kill();
  await expect(sourceTask).rejects.toThrowError();

  // Destroy the sink's stdin stream to let the process exit
  sinkTask.child.stdin.destroy();
  await expect(sinkTask).resolves.toMatchObject({ status: 0, stdout: '', stderr: '' });
});

it('throws errors with preserved stack traces when processes return non-zero exit codes', async () => {
  expect.assertions(2);
  try {
    await spawnAsync('false');
  } catch (e: any) {
    expect(e.stack).toMatch(/\n    \.\.\.\n/);
    expect(e.stack).toMatch(/at spawnAsync/);
  }
});

it(`rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER when stdout exceeds maxBuffer`, async () => {
  await expect(
    spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write("a".repeat(1000));'],
      { maxBuffer: 100 }
    )
  ).rejects.toMatchObject({
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    message: expect.stringMatching(/exceeded maxBuffer of 100 bytes/),
    stdout: 'a'.repeat(100),
    stderr: '',
    status: 0,
  });
});

it(`rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER when stderr exceeds maxBuffer`, async () => {
  await expect(
    spawnAsync(
      process.execPath,
      ['-e', 'process.stderr.write("b".repeat(1000));'],
      { maxBuffer: 50 }
    )
  ).rejects.toMatchObject({
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: '',
    stderr: 'b'.repeat(50),
  });
});

it(`preserves the most recent bytes via sliding window when maxBuffer is exceeded`, async () => {
  await expect(
    spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write("a".repeat(100), () => process.stdout.write("b".repeat(50)));'],
      { maxBuffer: 100 }
    )
  ).rejects.toMatchObject({
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: 'a'.repeat(50) + 'b'.repeat(50),
  });
});

it(`prefers the exit-code error over the maxBuffer error and exposes the truncated tail`, async () => {
  await expect(
    spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write("a".repeat(1000)); process.exit(2);'],
      { maxBuffer: 100 }
    )
  ).rejects.toMatchObject({
    message: expect.stringContaining('exited with non-zero code: 2'),
    stdout: 'a'.repeat(100),
    status: 2,
  });
});

it(`allows output up to but not exceeding maxBuffer`, async () => {
  const result = await spawnAsync(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(100));'],
    { maxBuffer: 100 }
  );
  expect(result.stdout).toBe('x'.repeat(100));
});

it(`does not enforce maxBuffer when ignoreStdio is true`, async () => {
  const result = await spawnAsync(
    process.execPath,
    ['-e', 'process.stdout.write("a".repeat(10000));'],
    { ignoreStdio: true, maxBuffer: 10 }
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});

it(`does not enforce maxBuffer when stdio bypasses pipe capture`, async () => {
  const result = await spawnAsync(
    process.execPath,
    ['-e', 'process.stdout.write("a".repeat(10000));'],
    { stdio: 'ignore', maxBuffer: 10 }
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});

it(`listens on 'exit' (not 'close') when stdio is not piped to us`, async () => {
  const task = spawnAsync('echo', ['hi'], { stdio: 'ignore' });
  expect(task.child.listenerCount('exit')).toBe(1);
  expect(task.child.listenerCount('close')).toBe(0);
  await task;
});

it(`listens on 'close' (not 'exit') when stdio is piped`, async () => {
  const task = spawnAsync('echo', ['hi']);
  expect(task.child.listenerCount('close')).toBe(1);
  expect(task.child.listenerCount('exit')).toBe(0);
  await task;
});

describe(`default-cap (lazy) maxBuffer path`, () => {
  // The lazy path only triggers against MAX_STRING_LENGTH (~512 MiB), which is
  // impractical to generate. Mock the constant so the same code path activates
  // at a testable size.
  function spawnAsyncWithCap(cap: number) {
    let task: any;
    jest.isolateModules(() => {
      jest.doMock('buffer', () => {
        const actual = jest.requireActual<typeof import('buffer')>('buffer');
        return {
          ...actual,
          constants: { ...actual.constants, MAX_STRING_LENGTH: cap },
        };
      });
      const localSpawnAsync = require('../spawnAsync');
      task = localSpawnAsync(
        process.execPath,
        ['-e', 'process.stdout.write("a".repeat(100), () => process.stdout.write("b".repeat(50)));']
      );
    });
    return task as Promise<SpawnResult> & { child: any };
  }

  it(`resolves the promise without rejecting`, async () => {
    const result = await spawnAsyncWithCap(100);
    expect(result.status).toBe(0);
    expect(result.signal).toBe(null);
  });

  it(`throws ERR_CHILD_PROCESS_STDIO_MAXBUFFER on stdout access with the truncated tail`, async () => {
    const result = await spawnAsyncWithCap(100);
    let error: any;
    try { void result.stdout; } catch (e) { error = e; }
    expect(error).toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: 'a'.repeat(50) + 'b'.repeat(50),
      stderr: '',
    });
  });

  it(`only throws on the overflowed stream; the other reads normally`, async () => {
    const result = await spawnAsyncWithCap(100);
    expect(result.stderr).toBe('');
    expect(() => result.stdout).toThrow();
  });
});

it(`exports TypeScript types`, async () => {
  let options: SpawnOptions = {};
  let promise: SpawnPromise<SpawnResult> = spawnAsync('echo', ['hi'], options);
  let result: SpawnResult = await promise;
  expect(typeof result.pid).toBe('number');
});
