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

  it(`throws errors when processes fail`, async () => {
    let didThrow = false;
    try {
      await spawnAsync('false');
    } catch (e) {
      didThrow = true;
      expect(typeof result.pid).toBe('number');
      expect(e.status).toBe(1);
    }
    expect(didThrow).toBe(true);
  });

  it(`throws errors when processes don't exist`, async () => {
    let didThrow = false;
    try {
      await spawnAsync('nonexistent-program');
    } catch (e) {
      didThrow = true;
      expect(e.pid).not.toBeDefined();
      expect(e.status).toBe('ENOENT');
    }
    expect(didThrow).toBe(true);
  });
});
