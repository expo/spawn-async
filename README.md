# spawn-async [![Tests](https://github.com/expo/spawn-async/actions/workflows/main.yml/badge.svg)](https://github.com/expo/spawn-async/actions/workflows/main.yml)

A cross-platform version of Node's `child_process.spawn` as an async function that returns a promise. Supports Node 12 LTS and up.

## Usage:
```js
import spawnAsync from '@expo/spawn-async';

(async function () {
  let resultPromise = spawnAsync('echo', ['hello', 'world']);
  let spawnedChildProcess = resultPromise.child;
  try {
    let {
      pid,
      output: [stdout, stderr],
      stdout,
      stderr,
      status,
      signal,
    } = await resultPromise;
  } catch (e) {
    console.error(e.stack);
    // The error object also has the same properties as the result object
  }
})();
```

## API

`spawnAsync` takes the same arguments as [`child_process.spawn`](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options). Its options are the same as those of `child_process.spawn` plus:

- `ignoreStdio`: whether to ignore waiting for the child process's stdio streams to close before resolving the result promise. When ignoring stdio, the returned values for `stdout` and `stderr` will be empty strings. The default value of this option is `false`.
- `maxBuffer`: the maximum bytes retained from `stdout` and `stderr` (independently). Output is collected with a sliding window. Exceeding the cap rejects the promise with `code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`; the most recent bytes that fit are attached to the error's stdio fields. The default is `buffer.constants.MAX_STRING_LENGTH`. Under `encoding: 'buffer'` the caller may pass a larger value, up to `buffer.constants.MAX_LENGTH`. Passing a value larger than the encoding's hard limit throws `TypeError` synchronously.
- `encoding`: selects whether the child's output is exposed as decoded strings or raw bytes. The default `'utf8'` (and any other [`BufferEncoding`](https://nodejs.org/api/buffer.html#buffers-and-character-encodings) value such as `'latin1'` or `'hex'`) decodes the child's output into a string. The value `'buffer'` keeps the output as raw `Uint8Array` instead. The `stdout` / `stderr` / `output` field names are the same in either mode; only their type changes.

It returns a promise whose result is an object with these properties:

- `pid`: the process ID of the spawned child process
- `stdout`: what the child process wrote to stdout — a `string` for text encodings, or a `Uint8Array` under `encoding: 'buffer'`
- `stderr`: same shape as `stdout`, but for stderr
- `output`: `[stdout, stderr]`
- `status`: the exit code of the child process
- `signal`: the signal (ex: `SIGTERM`) used to stop the child process if it did not exit on its own

The `Uint8Array` returned by `'buffer'` mode is a Node `Buffer` at runtime, so callers who need `Buffer`-specific methods can do `Buffer.from(result.stdout)` for a zero-copy view of the same memory.

If there's an error running the child process or it exits with a non-zero status code, `spawnAsync` rejects the returned promise. The Error object also has the properties listed above.

### Reading binary output

```js
import fs from 'node:fs';
import spawnAsync from '@expo/spawn-async';

const result = await spawnAsync(
  'pandoc',
  ['--from=html', '--to=docx'],
  { encoding: 'buffer' }
);
result.child.stdin.end('<h1>Hello, world</h1>');
fs.writeFileSync('out.docx', result.stdout);  // Uint8Array
```

### Accessing the child process

Sometimes you may want to access the child process object--for example, if you wanted to attach event handlers to `stdio` or `stderr` and process data as it is available instead of waiting for the process to be resolved.

You can do this by accessing `.child` on the Promise that is returned by `spawnAsync`.

Here is an example:
```js
(async () => {
  let ffmpeg$ = spawnAsync('ffmpeg', ['-i', 'path/to/source.flac', '-codec:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', 'path/to/output.mp3']);
  let childProcess = ffmpeg$.child;
  childProcess.stdout.on('data', (data) => {
    console.log(`ffmpeg stdout: ${data}`);
  });
  childProcess.stderr.on('data', (data) => {
    console.error(`ffmpeg stderr: ${data}`);
  });
  let result = await ffmpeg$;
  console.log(`ffmpeg pid ${result.pid} exited with code ${result.code}`);
})();

```

## Notes

### `maxBuffer`

Set `maxBuffer` when child output could exhaust memory and crash the parent process, or when the command or arguments are influenced by untrusted input; an attacker can otherwise force unbounded output to crash the parent.

The default `maxBuffer` is `buffer.constants.MAX_STRING_LENGTH`. For text encodings that is also the runtime hard limit (the longest string `Buffer.toString()` can build without crashing). Under `encoding: 'buffer'` the runtime allows up to `buffer.constants.MAX_LENGTH`, but the default stays at `MAX_STRING_LENGTH` for consistency; callers that need more output pass a larger `maxBuffer` explicitly. At either size the materialized output can still exhaust process memory.

Exceeding the cap rejects the promise with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, regardless of whether the cap was explicit or the default. The most recent bytes that fit are attached to `error.stdout` and `error.stderr`.

Passing `maxBuffer` larger than the encoding's hard limit throws `TypeError` synchronously at the call site.

### Memory profile

During the child's lifetime the per-chunk buffers Node delivers are retained as they arrive. When the process exits the chunks are concatenated once and decoded if a text encoding was requested; at that moment peak memory is briefly ~2× the output size (the chunk array plus the concatenated result). The chunk references are dropped immediately afterward, so steady-state memory is ~1× the output: either the decoded string (text encodings) or the `Uint8Array` (`encoding: 'buffer'`).
