import { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'child_process';
import spawn from 'cross-spawn';

namespace spawnAsync {
  export interface SpawnOptions extends NodeSpawnOptions {
    ignoreStdio?: boolean;
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

function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options: spawnAsync.SpawnOptions = {}
): spawnAsync.SpawnPromise<spawnAsync.SpawnResult> {
  const stubError = new Error();
  const callerStack = stubError.stack ? stubError.stack.replace(/^.*/, '    ...') : null;

  let child: ChildProcess;
  let promise = new Promise((resolve, reject) => {
    let { ignoreStdio, ...nodeOptions } = options;
    // @ts-ignore: cross-spawn declares "args" to be a regular array instead of a read-only one
    child = spawn(command, args, nodeOptions);
    let stdout = '';
    let stderr = '';

    if (!ignoreStdio) {
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data;
        });
      }
    }

    let completionListener = (code: number | null, signal: string | null) => {
      child.removeListener('error', errorListener);
      let result: spawnAsync.SpawnResult = {
        pid: child.pid,
        output: [stdout, stderr],
        stdout,
        stderr,
        status: code,
        signal,
      };
      if (code !== 0) {
        let error = signal
          ? new Error(`${command} ${args.join(" ")} exited with signal: ${signal}`)
          : new Error(`${command} ${args.join(" ")} exited with non-zero code: ${code}`);
        if (error.stack && callerStack) {
          error.stack += `\n${callerStack}`;
        }
        Object.assign(error, result);
        reject(error);
      } else {
        resolve(result);
      }
    };

    let errorListener = (error: Error) => {
      if (ignoreStdio) {
        child.removeListener('exit', completionListener);
      } else {
        child.removeListener('close', completionListener);
      }
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

    if (ignoreStdio) {
      child.once('exit', completionListener);
    } else {
      child.once('close', completionListener);
    }
    child.once('error', errorListener);
  }) as spawnAsync.SpawnPromise<spawnAsync.SpawnResult>;
  // @ts-ignore: TypeScript isn't aware the Promise constructor argument runs synchronously and
  // thinks `child` is not yet defined
  promise.child = child;
  return promise;
}

export = spawnAsync;
