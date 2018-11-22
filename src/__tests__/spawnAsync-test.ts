import path from 'path';

import spawnAsync from '../spawnAsync';

describe('spawnAsync', () => {
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
    } catch (e) {
      didThrow = true;
      expect(typeof e.pid).toBe('number');
      expect(e.status).toBe(1);
      expect(e.signal).toBe(null);
    }
    expect(didThrow).toBe(true);
  });

  // NOTE: in a breaking change, signals should probably be treated like non-zero exit codes
  it(`returns when processes are killed with signals`, async () => {
    let result = await spawnAsync(path.join(__dirname, 'signal-self.sh'));
    expect(typeof result.pid).toBe('number');
    expect(result.status).toBe(null);
    expect(result.signal).toBe('SIGKILL');
  });

  it(`throws errors when processes don't exist`, async () => {
    let didThrow = false;
    try {
      await spawnAsync('nonexistent-program');
    } catch (e) {
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
});
