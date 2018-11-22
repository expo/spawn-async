import { ChildProcess, SpawnOptions } from 'child_process';
import spawn from 'cross-spawn';

interface SpawnPromise<T> extends Promise<T> {
  child: ChildProcess;
}

interface SpawnResult {
  pid: number;
  output: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
}

export = function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options?: SpawnOptions
): SpawnPromise<SpawnResult> {
  let child: ChildProcess;
  let promise = new Promise((resolve, reject) => {
    // @ts-ignore: cross-spawn declares "args" to be a regular array instead of a read-only one
    child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', data => {
        stdout += data;
      });
    }

    if (child.stderr) {
      child.stderr.on('data', data => {
        stderr += data;
      });
    }

    let closeListener = (code: number | null, signal: string | null) => {
      child.removeListener('error', errorListener);
      let result: SpawnResult = {
        pid: child.pid,
        output: [stdout, stderr],
        stdout,
        stderr,
        status: code,
        signal,
      };
      if (code !== 0) {
        let error = signal
          ? new Error(`Process exited with signal: ${signal}`)
          : new Error(`Process exited with non-zero code: ${code}`);
        Object.assign(error, result);
        reject(error);
      } else {
        resolve(result);
      }
    };

    let errorListener = (error: Error) => {
      child.removeListener('close', closeListener);
      Object.assign(error, {
        pid: child.pid,
        output: [stdout, stderr],
        stdout,
        stderr,
        status: null,
        signal: null,
      });
      reject(error);
    };

    child.once('close', closeListener);
    child.once('error', errorListener);
  }) as SpawnPromise<SpawnResult>;
  // @ts-ignore: TypeScript isn't aware the Promise constructor argument runs synchronously and
  // thinks `child` is not yet defined
  promise.child = child;
  return promise;
};
