'use strict';

let spawn = (process.platform === 'win32') ?
  require('win-spawn') :
  require('child_process').spawn;

module.exports = function spawnAsync() {
  let args = Array.prototype.slice.call(arguments, 0);
  let child;
  let promise = new Promise((fulfill, reject) => {
    child = spawn.apply(spawn, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data;
    });
    child.stderr.on('data', data => {
      stderr += data;
    });

    child.on('exit', (code, signal) => {
      let result = {
        pid: child.pid,
        output: [stdout, stderr],
        stdout,
        stderr,
        status: code,
        signal,
      };
      if (code) {
        let error = new Error(`Process exited with non-zero code: ${code}`);
        Object.assign(error, result);
        reject(error);
      } else {
        fulfill(result);
      }
    });
  });
  promise.child = child;
  return promise;
};
