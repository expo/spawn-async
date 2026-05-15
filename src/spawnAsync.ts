import { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'child_process';
import { constants as bufferConstants } from 'buffer';
import spawn from 'cross-spawn';

namespace spawnAsync {
  export interface SpawnOptions extends NodeSpawnOptions {
    ignoreStdio?: boolean;
    maxBuffer?: number;
  }

  export interface SpawnPromise<T> extends Promise<T> {
    child: ChildProcess;
  }

  export interface SpawnResult {
    pid?: number;
    output: string[];
    stdout: string;
    stderr: string;
    status: number | null;
    signal: string | null;
  }
}

type IOChunk = string | Buffer;

interface IOChunksState {
  buffer: IOChunk[];
  maxExceeded: boolean;
}

const DEFAULT_MAX_BUFFER = bufferConstants.MAX_STRING_LENGTH;

function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options: spawnAsync.SpawnOptions = {}
): spawnAsync.SpawnPromise<spawnAsync.SpawnResult> {
  const stubError = new Error();
  const callerStack = stubError.stack ? stubError.stack.replace(/^.*/, '    ...') : null;

  const {
    ignoreStdio: optionsIgnoreStdio,
    maxBuffer: optionsMaxBuffer,
    ...nodeOptions
  } = options;

  // NOTE(@kitten): When `maxBuffer` is set explicitly, we enforce it strictly
  // and don't produce a result without it being strictly enforced
  const enforceMaxBufferStrictly = options.maxBuffer != null;

  const ignoreStdio = !!optionsIgnoreStdio;
  const maxBuffer = Math.min(
    optionsMaxBuffer ?? DEFAULT_MAX_BUFFER,
    bufferConstants.MAX_STRING_LENGTH,
  );

  let child: ChildProcess = spawn(command, args, nodeOptions);
  let promise = new Promise((resolve, reject) => {
    const stdoutChunks: IOChunksState = { buffer: [], maxExceeded: false };
    const stderrChunks: IOChunksState = { buffer: [], maxExceeded: false };

    function makeHandler(chunks: IOChunksState) {
      let length = 0;
      return (chunk: IOChunk) => {
        chunks.buffer.push(chunk);
        length += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        while (chunks.buffer.length > 0 && length > maxBuffer) {
          chunks.maxExceeded = true;
          chunk = chunks.buffer[0];
          const chunkLength = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
          if (length - chunkLength <= maxBuffer) {
            const replacement = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            const excess = length - maxBuffer;
            chunks.buffer[0] = replacement.subarray(excess);
            length -= excess;
            break;
          } else {
            chunks.buffer.shift();
            length -= chunkLength;
          }
        }
      };
    }

    function attachResult<T extends spawnAsync.SpawnResult | (Error & Partial<spawnAsync.SpawnResult>)>(
      target: T,
      assign: Partial<spawnAsync.SpawnResult>,
      stdoutChunks: IOChunksState,
      stderrChunks: IOChunksState,
      skipMaxBufferCheck?: boolean,
    ): T {
      function makeMaxBufferError() {
        const argumentString = args && args.length > 0 ? ` ${args.join(' ')}` : '';
        const error: Error & { code?: string } = new Error(`${command}${argumentString} exceeded maxBuffer of ${maxBuffer} bytes`);
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        return attachResult(error, assign, stdoutChunks, stderrChunks, true);
      }

      let _stdout: string | undefined;
      let _stderr: string | undefined;
      const map: PropertyDescriptorMap = {
        stdout: {
          enumerable: true,
          configurable: true,
          get() {
            if (!skipMaxBufferCheck && stdoutChunks.maxExceeded) {
              throw makeMaxBufferError();
            } else if (_stdout === undefined) {
              _stdout = Buffer.concat(
                stdoutChunks.buffer.map((chunk) => typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
              ).toString('utf8');
            }
            return _stdout;
          },
        },
        stderr: {
          enumerable: true,
          configurable: true,
          get() {
            if (!skipMaxBufferCheck && stderrChunks.maxExceeded) {
              throw makeMaxBufferError();
            } else if (_stderr === undefined) {
              _stderr = Buffer.concat(
                stderrChunks.buffer.map((chunk) => typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
              ).toString('utf8');
            }
            return _stderr;
          },
        },
        output: {
          enumerable: true,
          configurable: true,
          get: () => [target.stdout, target.stderr],
        },
      };
      for (const key in assign) {
        map[key] = {
          value: assign[key as keyof spawnAsync.SpawnResult],
          enumerable: true,
          writable: true,
          configurable: true,
        };
      }
      Object.defineProperties(target, map);
      return target;
    }

    if (!ignoreStdio) {
      child.stdout?.on('data', makeHandler(stdoutChunks));
      child.stderr?.on('data', makeHandler(stderrChunks));
    }

    // Use 'exit' instead of 'close' when there are no piped stdio streams for us to drain;
    // 'close' can be deferred past 'exit' when the child has grandchildren that inherit its
    // stdio fds, so waiting on it without anything to read just stalls
    const completionEvent =
      ignoreStdio || (!child.stdout && !child.stderr) ? 'exit' : 'close';

    let completionListener = (code: number | null, signal: string | null) => {
      child.removeListener('error', errorListener);
      const argumentString = args && args.length > 0 ? ` ${args.join(' ')}` : '';
      let error: (Error & { code?: string }) | null = null;
      if (code !== 0) {
        error = signal
          ? new Error(`${command}${argumentString} exited with signal: ${signal}`)
          : new Error(`${command}${argumentString} exited with non-zero code: ${code}`);
      }
      const assignResult: Partial<spawnAsync.SpawnResult> = {
        pid: child.pid,
        status: code,
        signal,
      };
      if (error) {
        if (error.stack && callerStack) error.stack += `\n${callerStack}`;
        // When we're already rejecting, we don't enforce the max buffer error, and accept that we
        // may truncate stderr/stdout
        reject(attachResult(error, assignResult, stdoutChunks, stderrChunks, true));
      } else if (enforceMaxBufferStrictly && (stdoutChunks.maxExceeded || stderrChunks.maxExceeded)) {
        // When a `maxBuffer` is passed, we enforce the maximum on stdout and stderr strictly
        const error: Error & { code?: string } = new Error(`${command}${argumentString} exceeded maxBuffer of ${maxBuffer} bytes`);
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        reject(attachResult(error, assignResult, stdoutChunks, stderrChunks, true));
      } else {
        const result = {} as spawnAsync.SpawnResult;
        resolve(attachResult(result, assignResult, stdoutChunks, stderrChunks));
      }
    };

    let errorListener = (error: Error) => {
      child.removeListener(completionEvent, completionListener);
      const assignResult: Partial<spawnAsync.SpawnResult> = {
        pid: child.pid,
        status: null,
        signal: null,
      };
      reject(attachResult(error, assignResult, stdoutChunks, stderrChunks));
    };

    child.once(completionEvent, completionListener);
    child.once('error', errorListener);
  }) as spawnAsync.SpawnPromise<spawnAsync.SpawnResult>;

  promise.child = child;
  return promise;
}

export = spawnAsync;
