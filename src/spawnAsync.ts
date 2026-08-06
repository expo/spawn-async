import { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'child_process';
import { constants as bufferConstants } from 'buffer';
import spawn from 'cross-spawn';

namespace spawnAsync {
  export interface SpawnOptions extends NodeSpawnOptions {
    ignoreStdio?: boolean;
    maxBuffer?: number;
    /**
     * Selects the type of `stdout` / `stderr` on the resolved result.
     *
     * - A `BufferEncoding` (the default "utf8", or "latin1", "hex", etc.)
     *   decodes the child's output to a string.
     * - "buffer" keeps the output as raw bytes (`Uint8Array`).
     *
     * Bytes are typed as `Uint8Array`; the runtime value is a Node `Buffer`,
     * which extends `Uint8Array`, so no conversion is performed.
     */
    encoding?: BufferEncoding | 'buffer';
  }

  export interface SpawnPromise<T> extends Promise<T> {
    child: ChildProcess;
  }

  // Parameterized on the stdio element type. Defaults to `string`, so existing
  // `SpawnResult` references resolve to the text shape with no source changes.
  // `encoding: "buffer"` returns `SpawnResult<Uint8Array>`.
  export interface SpawnResult<T = string> {
    pid?: number;
    output: T[];
    stdout: T;
    stderr: T;
    status: number | null;
    signal: string | null;
  }
}

type IOChunk = string | Buffer;

interface IOChunksState {
  buffer: IOChunk[];
  maxExceeded: boolean;
}

// `encoding: "buffer"` (the literal) returns the bytes shape; everything else
// (no options, a text encoding, or a `SpawnOptions`-typed variable that doesn't
// statically pin "buffer") returns the string shape. This is the same overload
// pattern Node uses for `child_process.spawnSync`.
function spawnAsync(
  command: string,
  args: ReadonlyArray<string> | undefined,
  options: spawnAsync.SpawnOptions & { encoding: 'buffer' }
): spawnAsync.SpawnPromise<spawnAsync.SpawnResult<Uint8Array>>;
function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options?: spawnAsync.SpawnOptions
): spawnAsync.SpawnPromise<spawnAsync.SpawnResult>;
function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options: spawnAsync.SpawnOptions = {}
): spawnAsync.SpawnPromise<spawnAsync.SpawnResult<string | Uint8Array>> {
  const stubError = new Error();
  const callerStack = stubError.stack ? stubError.stack.replace(/^.*/, '    ...') : null;

  const {
    ignoreStdio: optionsIgnoreStdio,
    maxBuffer: optionsMaxBuffer,
    encoding: optionsEncoding,
    ...nodeOptions
  } = options;

  const encoding: BufferEncoding | 'buffer' = optionsEncoding ?? 'utf8';
  const wantsBytes = encoding === 'buffer';

  const explicitMaxBuffer = optionsMaxBuffer != null;
  const ignoreStdio = !!optionsIgnoreStdio;
  // The runtime hard limit (the largest value `maxBuffer` may take). Text
  // encodings go through `Buffer.toString()`, which cannot produce a string
  // longer than `MAX_STRING_LENGTH` without crashing the runtime. The "buffer"
  // encoding skips the string conversion, so its only ceiling is the maximum
  // size of a single `Buffer` (`MAX_LENGTH`).
  const hardLimit = wantsBytes
    ? bufferConstants.MAX_LENGTH
    : bufferConstants.MAX_STRING_LENGTH;
  // Validate the caller's maxBuffer against the runtime hard limit. Silently
  // clamping was the previous behavior and led to confusing rejection messages
  // later. Surface the misconfiguration synchronously so it's obvious at the
  // call site.
  if (optionsMaxBuffer != null && optionsMaxBuffer > hardLimit) {
    const limitName = wantsBytes
      ? 'buffer.constants.MAX_LENGTH'
      : 'buffer.constants.MAX_STRING_LENGTH';
    const remedy = wantsBytes
      ? ''
      : ' Pass encoding: "buffer" to raise the ceiling to buffer.constants.MAX_LENGTH.';
    throw new TypeError(
      `maxBuffer (${optionsMaxBuffer}) exceeds the maximum ` +
        `${wantsBytes ? 'byte array' : 'string'} length ` +
        `(${hardLimit}, ${limitName}).${remedy}`,
    );
  }
  // Default cap is `MAX_STRING_LENGTH` regardless of encoding. Under
  // `encoding: "buffer"`, the runtime allows up to `MAX_LENGTH`, so a caller
  // that wants more output explicitly passes a larger `maxBuffer` (the
  // TypeError above bounds it to `MAX_LENGTH`).
  const maxBuffer = optionsMaxBuffer ?? bufferConstants.MAX_STRING_LENGTH;

  let child: ChildProcess = spawn(command, args, nodeOptions);
  let promise = new Promise<spawnAsync.SpawnResult<string | Uint8Array>>(
    (resolve, reject) => {
      const stdoutChunks: IOChunksState = { buffer: [], maxExceeded: false };
      const stderrChunks: IOChunksState = { buffer: [], maxExceeded: false };

      // Build the `'data'` listener for one stream: it appends each chunk and
      // keeps the retained total within `maxBuffer` by dropping the oldest bytes
      // (a sliding window). Each stream gets its own listener with its own
      // running `length`.
      function makeChunkCollector(chunks: IOChunksState) {
        let length = 0;
        return function collectChunk(chunk: IOChunk) {
          chunks.buffer.push(chunk);
          length += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
          while (chunks.buffer.length > 0 && length > maxBuffer) {
            chunks.maxExceeded = true;
            chunk = chunks.buffer[0];
            const chunkLength = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            if (length - chunkLength < maxBuffer) {
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

      // Concatenate a stream's chunks into one contiguous buffer and drop the
      // per-chunk references so they can be freed.
      function concatChunks(chunks: IOChunksState): Buffer {
        const concatenated = Buffer.concat(
          chunks.buffer.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
        );
        chunks.buffer = [];
        return concatenated;
      }

      // Build the encoding-appropriate stdio fields as a plain object. Called
      // exactly once per spawn, so concatenating (and freeing the chunks) here
      // is the single materialization point.
      function stdioFields(): Pick<
        spawnAsync.SpawnResult<string | Uint8Array>,
        'stdout' | 'stderr' | 'output'
      > {
        if (wantsBytes) {
          const stdout = concatChunks(stdoutChunks);
          const stderr = concatChunks(stderrChunks);
          return { stdout, stderr, output: [stdout, stderr] };
        }
        const stdout = concatChunks(stdoutChunks).toString(encoding as BufferEncoding);
        const stderr = concatChunks(stderrChunks).toString(encoding as BufferEncoding);
        return { stdout, stderr, output: [stdout, stderr] };
      }

      if (!ignoreStdio) {
        child.stdout?.on('data', makeChunkCollector(stdoutChunks));
        child.stderr?.on('data', makeChunkCollector(stderrChunks));
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
        const meta = { pid: child.pid, status: code, signal };

        if (error) {
          if (error.stack && callerStack) error.stack += `\n${callerStack}`;
          // When the child exited non-zero we surface that error; the partial stdio is
          // attached to the rejection (potentially truncated by the sliding window).
          Object.assign(error, meta, stdioFields());
          reject(error);
        } else if (stdoutChunks.maxExceeded || stderrChunks.maxExceeded) {
          // Output exceeded the cap and the sliding window truncated bytes.
          // Reject rather than silently returning a clipped result. The
          // default cap is `MAX_STRING_LENGTH` for both encodings. In text
          // mode that is also the runtime hard limit, so the only remedy is
          // switching to `encoding: "buffer"`. In buffer mode the default is
          // just a chosen cap and the caller can raise `maxBuffer` up to
          // `MAX_LENGTH` to capture more.
          let message: string;
          if (explicitMaxBuffer) {
            message = `${command}${argumentString} exceeded maxBuffer of ${maxBuffer} bytes`;
          } else if (wantsBytes) {
            message =
              `${command}${argumentString} exceeded the default maxBuffer of ${maxBuffer} bytes. ` +
              `Pass maxBuffer to capture more output (up to buffer.constants.MAX_LENGTH).`;
          } else {
            message =
              `${command}${argumentString} exceeded the maximum string length ` +
              `(${maxBuffer} bytes, buffer.constants.MAX_STRING_LENGTH). Pass ` +
              `encoding: "buffer" to capture this output as raw bytes.`;
          }
          const error: Error & { code?: string } = new Error(message);
          error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          Object.assign(error, meta, stdioFields());
          reject(error);
        } else {
          resolve({ ...meta, ...stdioFields() });
        }
      };

      let errorListener = (error: Error) => {
        child.removeListener(completionEvent, completionListener);
        Object.assign(error, { pid: child.pid, status: null, signal: null }, stdioFields());
        reject(error);
      };

      child.once(completionEvent, completionListener);
      child.once('error', errorListener);
    },
  ) as spawnAsync.SpawnPromise<spawnAsync.SpawnResult<string | Uint8Array>>;

  promise.child = child;
  return promise;
}

export = spawnAsync;
