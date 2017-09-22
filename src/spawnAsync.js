'use strict';

const spawn = require('cross-spawn');

module.exports = function spawnAsync(...args) {
  let child;
  let promise = new Promise((fulfill, reject) => {
    child = spawn.apply(spawn, args);
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

    child.on('close', (code, signal) => {
      child.removeAllListeners();
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

    child.on('error', error => {
      child.removeAllListeners();
      error.pid = child.pid;
      error.output = [stdout, stderr];
      error.stdout = stdout;
      error.stderr = stderr;
      error.status = null;
      reject(error);
    });
  });
  promise.child = child;
  return promise;
};
