import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_LIMITS } from '../../packages/core/src/local/index.ts';

const state = vi.hoisted(() => ({ mode: '', sourceReads: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args); const path = String(args[0]).replace(/\\/g, '/');
      if (path.includes('/fixtures/repos/')) state.sourceReads++;
      if (path.endsWith('/src/index.ts')) {
        if (state.mode === 'tamper') return Buffer.concat([value as Buffer, Buffer.from('\n// altered')]);
        if (state.mode === 'invalid-utf8') return Buffer.concat([value as Buffer, Buffer.from([255])]);
      }
      if (path.endsWith('/fixtures/catalog.json') && state.mode === 'catalog-traversal') {
        const catalog = JSON.parse(String(value)); catalog.snapshots[0].files[0] = '../outside.ts'; return Buffer.from(JSON.stringify(catalog));
      }
      return value;
    }),
    lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
      const value = await actual.lstat(...args); const path = String(args[0]).replace(/\\/g, '/');
      if (path.endsWith('/src/index.ts')) {
        if (state.mode === 'symlink') return { ...value, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };
        if (state.mode === 'oversized') return { ...value, size: LOCAL_LIMITS.fileCharacters + 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
      }
      return value;
    }),
  };
});
import { indexFixture } from '../../apps/worker/src/fixture-service.ts';

describe('fixture I/O rejection boundary', () => {
  beforeEach(() => { state.mode = ''; state.sourceReads = 0; });
  it('rejects source bytes that differ from the catalog SHA-256 snapshot', async () => {
    state.mode = 'tamper'; await expect(indexFixture('retry-kit@1.0.0')).rejects.toThrow('digest differs');
  });
  it('rejects symlinks before reading their contents', async () => {
    state.mode = 'symlink'; await expect(indexFixture('retry-kit@1.0.0')).rejects.toThrow('symlinks');
  });
  it('rejects oversized files before allocating their contents', async () => {
    state.mode = 'oversized'; await expect(indexFixture('retry-kit@1.0.0')).rejects.toThrow('byte limit');
  });
  it('rejects catalog traversal paths before reading any repository source', async () => {
    state.mode = 'catalog-traversal'; await expect(indexFixture('jobboard-app@1.0.0')).rejects.toThrow('catalog entry');
    expect(state.sourceReads).toBe(0);
  });
  it('rejects invalid UTF-8 source rather than replacing bytes', async () => {
    state.mode = 'invalid-utf8'; await expect(indexFixture('retry-kit@1.0.0')).rejects.toThrow();
  });
});
