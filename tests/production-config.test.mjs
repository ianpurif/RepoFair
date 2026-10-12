import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProductionEnvironment } from '../scripts/verify-production-env.mjs';

const configured = {
  VERCEL_ENV: 'production', APP_ORIGIN: 'https://atlas.example.com', ATLAS_PUBLIC_ORIGIN: 'https://atlas.example.com',
  ATLAS_MODE: 'tempo-testnet', NEXT_PUBLIC_ATLAS_MODE: 'tempo-testnet', ATLAS_FIXTURES_ENABLED: 'false',
  TEMPO_CHAIN_ID: '42431', TEMPO_TOKEN_ADDRESS: '0x20c0000000000000000000000000000000000000',
  TEMPO_RPC_URL: 'https://rpc.example.com/network', DATABASE_URL: 'postgresql://user:password@db.example.com/atlas',
  DATABASE_SSL_CA: 'synthetic-ca', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_ZXhhbXBsZS5jb20k',
  CLERK_SECRET_KEY: 'sk_live_abcdefghijklmnopqrstuvwxyz', GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'synthetic-key', GITHUB_WEBHOOK_SECRET: 'synthetic-webhook-secret',
  ATLAS_PUBLICATION_SIGNING_KEY: 'synthetic-key',
};

test('production requires permanent HTTPS origins, live identity, real providers and inline secret sources', () => {
  assert.deepEqual(checkProductionEnvironment(configured), []);
  const rejected = checkProductionEnvironment({ ...configured, APP_ORIGIN: 'https://demo.trycloudflare.com',
    ATLAS_PUBLIC_ORIGIN: 'https://demo.trycloudflare.com', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jb20k',
    DATABASE_SSL_CA_FILE: '/tmp/ca.pem', ATLAS_FIXTURES_ENABLED: 'true' });
  assert.ok(rejected.some(issue => issue.includes('APP_ORIGIN')));
  assert.ok(rejected.some(issue => issue.includes('Clerk live')));
  assert.ok(rejected.some(issue => issue.includes('inline DATABASE_SSL_CA')));
  assert.ok(rejected.some(issue => issue.includes('ATLAS_FIXTURES_ENABLED')));
  assert.ok(rejected.every(issue => !issue.includes('synthetic-key')));
});

test('nonproduction builds skip production-only requirements', () => {
  assert.deepEqual(checkProductionEnvironment({ VERCEL_ENV: 'preview' }), []);
});

test('invalid origin diagnostics never echo supplied credential-bearing URL values', () => {
  const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';
  const problems = checkProductionEnvironment({ ...configured,
    APP_ORIGIN: `https://review-user:${sentinel}@atlas.example.com`,
    ATLAS_PUBLIC_ORIGIN: 'https://atlas.example.com',
  });
  assert.ok(problems.some(issue => issue.includes('ATLAS_PUBLIC_ORIGIN must exactly match APP_ORIGIN')));
  assert.ok(problems.every(issue => !issue.includes(sentinel) && !issue.includes('review-user')));
});
