import { describe, expect, it } from 'vitest';
import { assertExpectedRuntimeOwner, readRuntimeLogOrPlaceholder } from './desktop-packaged-matrix-utils.mjs';

describe('desktop packaged matrix diagnostics', () => {
  it('fails immediately when port 9210 belongs to another runtime', () => {
    expect(() => assertExpectedRuntimeOwner({ mozi_home: '/existing/app/home' }, '/isolated/matrix/home'))
      .toThrow('port already owned by /existing/app/home');
  });

  it('reports a missing runtime log without replacing the real startup failure', () => {
    expect(readRuntimeLogOrPlaceholder('/definitely/missing/mozi/runtime.log'))
      .toBe('(runtime log was not created)');
  });
});
