var child_process = require('child_process');

module.exports = function () {
  var args = Array.prototype.slice.call(arguments, 0);
  var child = child_process.spawn.apply(child_process, args);
  var p = new Promise(function (fulfill, reject) {
    child.on('close', function (code) {
      if (code) {
        reject(new Error("Process exited with non-zero code: " + code));
      } else {
        fulfill(0);
      }
    });
  });
  p.child = child;
  return p;
};
