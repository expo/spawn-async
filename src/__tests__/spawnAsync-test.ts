import assert from 'assert';
import { constants as bufferConstants } from 'buffer';
import path from 'path';

import spawnAsync, { SpawnOptions, SpawnPromise, SpawnResult } from '../spawnAsync';

// Captured at file load, before any `jest.doMock('buffer', …)` in later tests
// can swap the constants out from under us.
const REAL_MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const REAL_MAX_LENGTH = bufferConstants.MAX_LENGTH;

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

describe(`default-cap maxBuffer path`, () => {
  // The default text cap is MAX_STRING_LENGTH (~512 MiB), which is impractical
  // to generate. Mock the constant so the same code path activates at a
  // testable size.
  function spawnAsyncWithCap(
    cap: number,
    encoding?: spawnAsync.SpawnOptions['encoding']
  ) {
    let task: any;
    jest.isolateModules(() => {
      jest.doMock('buffer', () => {
        const actual = jest.requireActual<typeof import('buffer')>('buffer');
        return {
          ...actual,
          constants: {
            ...actual.constants,
            MAX_STRING_LENGTH: cap,
            MAX_LENGTH: cap,
          },
        };
      });
      const localSpawnAsync = require('../spawnAsync');
      task = localSpawnAsync(
        process.execPath,
        ['-e', 'process.stdout.write("a".repeat(100), () => process.stdout.write("b".repeat(50)));'],
        encoding ? { encoding } : undefined
      );
    });
    return task;
  }

  it(`rejects suggesting the string-length limit when text output exceeds it`, async () => {
    let caught: any;
    try {
      await spawnAsyncWithCap(100);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(caught.message).toMatch(/the maximum string length \(100 bytes, buffer\.constants\.MAX_STRING_LENGTH\)/);
    // Suggests the only real remedy: switching to bytes.
    expect(caught.message).toMatch(/encoding: "buffer"/);
    // The sliding-window tail is still attached so callers can inspect it.
    expect(caught.stdout).toBe('a'.repeat(50) + 'b'.repeat(50));
    expect(caught.stderr).toBe('');
    expect(caught.status).toBe(0);
  });

  it(`rejects suggesting a larger maxBuffer when bytes output exceeds the default cap`, async () => {
    let caught: any;
    try {
      await spawnAsyncWithCap(100, 'buffer');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(caught.message).toMatch(/exceeded the default maxBuffer of 100 bytes/);
    // The default cap in buffer mode is not the runtime ceiling, so the
    // message points the caller at a larger maxBuffer.
    expect(caught.message).toMatch(/Pass maxBuffer to capture more output/);
    expect(caught.message).toMatch(/buffer\.constants\.MAX_LENGTH/);
    expect(Buffer.from(caught.stdout).toString()).toBe(
      'a'.repeat(50) + 'b'.repeat(50)
    );
  });
});

it(`exports TypeScript types`, async () => {
  let options: SpawnOptions = {};
  let promise: SpawnPromise<SpawnResult> = spawnAsync('echo', ['hi'], options);
  let result: SpawnResult = await promise;
  expect(typeof result.pid).toBe('number');
});

describe(`encoding: 'buffer'`, () => {
  it(`returns stdout/stderr as Uint8Array`, async () => {
    const expected = Buffer.from([0, 1, 2, 0xff, 0x80, 0x7f]);
    const result = await spawnAsync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(Buffer.from(${JSON.stringify(Array.from(expected))}));`,
      ],
      { encoding: 'buffer' }
    );
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect(result.stdout.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(result.stdout).equals(expected)).toBe(true);
    expect(result.stderr.byteLength).toBe(0);
  });

  it(`survives a byte sequence that is not valid UTF-8`, async () => {
    // The continuation byte 0xC0 followed by 0x00 would be replaced by U+FFFD
    // when decoded as UTF-8, losing information. With encoding: 'buffer' we get
    // the exact bytes back.
    const bytes = Buffer.from([0xc0, 0x00, 0xc1, 0xff]);
    const result = await spawnAsync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(Buffer.from(${JSON.stringify(Array.from(bytes))}));`,
      ],
      { encoding: 'buffer' }
    );
    expect(Buffer.from(result.stdout).equals(bytes)).toBe(true);
  });

  it(`populates output as [stdout, stderr] of Uint8Array`, async () => {
    const result = await spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write("ok"); process.stderr.write("warn");'],
      { encoding: 'buffer' }
    );
    expect(result.output).toHaveLength(2);
    expect(result.output[0]).toBe(result.stdout);
    expect(result.output[1]).toBe(result.stderr);
    expect(result.output[0]).toBeInstanceOf(Uint8Array);
  });

  it(`attaches bytes to the error on non-zero exit, like string stdout`, async () => {
    const expected = Buffer.from([0x10, 0x20, 0x30]);
    let caught: any;
    try {
      await spawnAsync(
        process.execPath,
        [
          '-e',
          `process.stdout.write(Buffer.from(${JSON.stringify(Array.from(expected))})); process.exit(7);`,
        ],
        { encoding: 'buffer' }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(7);
    expect(Buffer.from(caught.stdout).equals(expected)).toBe(true);
  });

  it(`enforces maxBuffer with encoding: 'buffer'`, async () => {
    await expect(
      spawnAsync(
        process.execPath,
        ['-e', 'process.stdout.write(Buffer.alloc(1000, 0xab));'],
        { encoding: 'buffer', maxBuffer: 100 }
      )
    ).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
  });
});

describe(`encoding: text encodings other than utf8`, () => {
  it(`decodes stdout with the requested encoding`, async () => {
    // Latin-1 maps 0x00–0xff one-to-one to U+0000–U+00FF. Bytes that would be
    // multibyte continuations in UTF-8 (e.g. 0xC0, 0xFF) decode cleanly here.
    const bytes = Buffer.from([0xc0, 0xc1, 0xff]);
    const result = await spawnAsync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(Buffer.from(${JSON.stringify(Array.from(bytes))}));`,
      ],
      { encoding: 'latin1' }
    );
    expect(result.stdout).toBe(bytes.toString('latin1'));
    expect(result.stdout).toBe('ÀÁÿ');
  });

  it(`decodes stdout with hex encoding`, async () => {
    const result = await spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]));'],
      { encoding: 'hex' }
    );
    expect(result.stdout).toBe('deadbeef');
  });
});

describe(`maxBuffer validation`, () => {
  it(`throws TypeError synchronously when maxBuffer exceeds MAX_STRING_LENGTH in text mode`, () => {
    expect(() =>
      spawnAsync('echo', ['hi'], { maxBuffer: REAL_MAX_STRING_LENGTH + 1 })
    ).toThrow(TypeError);
    expect(() =>
      spawnAsync('echo', ['hi'], { maxBuffer: REAL_MAX_STRING_LENGTH + 1 })
    ).toThrow(/exceeds the maximum string length/);
  });

  it(`throws TypeError synchronously when maxBuffer exceeds MAX_LENGTH in buffer mode`, () => {
    if (REAL_MAX_LENGTH >= Number.MAX_SAFE_INTEGER) {
      // On runtimes where MAX_LENGTH already equals MAX_SAFE_INTEGER there's
      // no representable integer Number larger than it, so this case is
      // unreachable. Recent Node sets MAX_LENGTH this high.
      return;
    }
    expect(() =>
      spawnAsync('echo', ['hi'], {
        encoding: 'buffer',
        maxBuffer: REAL_MAX_LENGTH + 1,
      })
    ).toThrow(/exceeds the maximum byte array length/);
  });

  it(`accepts maxBuffer exactly equal to MAX_STRING_LENGTH`, async () => {
    const result = await spawnAsync('echo', ['hi'], {
      maxBuffer: REAL_MAX_STRING_LENGTH,
    });
    expect(result.stdout).toBe('hi\n');
  });
});
