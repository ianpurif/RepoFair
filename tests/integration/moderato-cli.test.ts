import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODERATO_RPC, parseModeratoOptions, runModeratoCli } from '../../packages/sdk/examples/moderato.ts';
import type { ModeratoDependencies } from '../../packages/sdk/examples/moderato.ts';
import type { PaidKnowledge } from '../../packages/sdk/src/authenticated.ts';
import type { CatalogProvider, PurchaseBudget, PurchaseRecord } from '../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';

// Real CLI, viem read-only RPC transport and authenticated SDK execute against
// explicit in-process transport/file fixtures. No Clerk, hosted database, live
// HTTP/RPC, key generation, signature, funding, broadcast or settlement is used.
const origin = 'https://atlas.cli-fixture.dev';
const workspaceId = '11000000-0000-4000-8000-000000000001';
const providerId = '22000000-0000-4000-8000-000000000002';
const purchaseId = '33000000-0000-4000-8000-000000000003';
const tokenFile = join(tmpdir(), 'atlas-cli-synthetic-token.jwt');
const keyFile = join(tmpdir(), 'atlas-cli-nonexistent-signing-key.txt');
const common = ['--origin', origin, '--token-file', tokenFile];
const selection = ['--provider', providerId, '--question', 'How does retry work?'];
const purchase = ['--purchase', ...common, ...selection, '--approve-atomic-amount', '1000', '--key-file', keyFile, '--idempotency-key', 'synthetic_cli_purchase_0001'];
const provider: CatalogProvider = { id: providerId, packageName: '@fixture/cli', version: '1.2.3', endpoint: 'https://provider.cli-fixture.dev/context/retrieve', realm: 'cli-fixture',
  accessPolicy: 'authenticated', network: MODERATO_NETWORK, token: MODERATO_PATHUSD, recipient: `0x${'2'.repeat(40)}`, atomicPrice: '1000', tokenDecimals: 6,
  commitSha: 'a'.repeat(40), snapshotId: '44000000-0000-4000-8000-000000000004', publicationDigest: 'b'.repeat(64), rightsStatement: 'Synthetic fixture declaration' };
const budget: PurchaseBudget = { network: MODERATO_NETWORK, token: MODERATO_PATHUSD, allowance: '5000', reserved: '1000', spent: '2000' };
const record: PurchaseRecord = { id: purchaseId, providerId, packageName: provider.packageName, version: provider.version, network: MODERATO_NETWORK,
  token: MODERATO_PATHUSD, recipient: provider.recipient, atomicAmount: '1000', paymentState: 'settled', deliveryState: 'ready', receiptReference: null,
  createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
const delivered: PaidKnowledge = { purchase: record, context: { schemaVersion: 1, providerId, packageName: provider.packageName, version: provider.version,
  evidenceState: 'insufficient', nodes: [], edges: [], limitations: ['Explicit synthetic transport; no real payment'], evidence: [{ id: 'synthetic-evidence',
    scope: { tenantId: workspaceId, principalId: 'synthetic-cli-principal', permissionRevision: 'fixture:1' },
    source: { repositoryId: '55000000-0000-4000-8000-000000000005', snapshotId: provider.snapshotId, kind: 'fixture', revision: provider.commitSha, path: 'synthetic.ts', startLine: 1, endLine: 1 },
    original: 'SYNTHETIC_PRIVATE_SOURCE_SENTINEL', providerId, observedAt: '2026-10-12T00:00:00Z', provenance: 'provider-reported' }] }, sourceSignatures: {}, graphSignatures: { nodes: {}, edges: {} } };
type FixtureOptions = { chainId?: number; providers?: CatalogProvider[]; budgets?: PurchaseBudget[]; purchases?: PurchaseRecord[];
  workspaces?: { id: string; name: string; role: string }[]; apiError?: boolean; rpcError?: boolean };
function fixture(options: FixtureOptions = {}) {
  const output: string[] = [], rpcMethods: string[] = [], tokenReads: string[] = [];
  const requests: { method: string; path: string; authorization: string | null; body: string; paymentCredential: string | null }[] = [];
  const loadSigner = vi.fn(async () => { throw new Error('SYNTHETIC_SENSITIVE_SIGNER_ERROR'); });
  const readText = vi.fn(async (file: string) => { tokenReads.push(file); return `synthetic-session-${tokenReads.length}`; });
  const rpcFetch: typeof fetch = async (input, init) => {
    expect(new URL(String(input)).origin).toBe(MODERATO_RPC);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
    rpcMethods.push(rpc.method);
    expect(rpc.method).toBe('eth_chainId');
    if (options.rpcError) throw new Error('SYNTHETIC_SENSITIVE_RPC_ERROR');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: `0x${(options.chainId ?? 42431).toString(16)}` });
  };
  const atlasFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin); expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, authorization: headers.get('Authorization'), body: String(init?.body ?? ''), paymentCredential: headers.get('Payment-Authorization') });
    if (options.apiError) return Response.json({ code: 'session-required', error: 'SYNTHETIC_SENSITIVE_API_ERROR' }, { status: 401 });
    if (url.pathname === '/api/account') return Response.json({ authenticated: true, principalId: 'synthetic-cli-principal', workspaces: options.workspaces ?? [{ id: workspaceId, name: 'Synthetic workspace', role: 'owner' }] });
    if (url.pathname === '/api/catalog') return Response.json({ providers: options.providers ?? [provider] });
    if (url.pathname === '/api/purchases' && init?.method === 'GET') return Response.json({ budgets: options.budgets ?? [budget], purchases: options.purchases ?? [] });
    if (url.pathname === `/api/purchases/${purchaseId}/resume`) return Response.json(delivered);
    throw new Error('Synthetic boundary forbids reservation, budget mutation, signing claim or charge');
  };
  const dependencies: ModeratoDependencies = { rpcFetch, atlasFetch, readText, loadSigner, stdout: value => output.push(value) };
  return { dependencies, output, requests, rpcMethods, tokenReads, loadSigner };
}
let directory = '';
const createdFiles: string[] = [];
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'atlas-moderato-cli-')); });
afterAll(async () => {
  for (const file of createdFiles) await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
});

describe('caller-owned Moderato CLI with explicit synthetic transports', () => {
  it('default check reads real SDK routes and RPC chain without a reservation, key or signature', async () => {
    const test = fixture(); expect(await runModeratoCli([...common, ...selection], test.dependencies)).toBe(0);
    expect(test.requests.map(request => [request.method, request.path])).toEqual([['GET', '/api/account'], ['GET', '/api/catalog'], ['GET', '/api/purchases']]);
    expect(test.rpcMethods).toEqual(['eth_chainId']); expect(test.loadSigner).not.toHaveBeenCalled();
    expect(JSON.parse(test.output[0]!)).toMatchObject({ readOnly: true, chainId: 42431, atomicPrice: '1000', pricePathUsd: '0.001000', remaining: '2000', signing: 'unverified', settlement: 'unverified', gasFunding: 'unverified' });
  });
  it('rereads the caller token file per request and confines each credential to Atlas', async () => {
    const test = fixture(); await runModeratoCli(['--check', ...common, ...selection], test.dependencies);
    expect(test.tokenReads).toEqual([tokenFile, tokenFile, tokenFile]);
    expect(test.requests.map(request => request.authorization)).toEqual(['Bearer synthetic-session-1', 'Bearer synthetic-session-2', 'Bearer synthetic-session-3']);
    expect(test.output.join('\n')).not.toContain('synthetic-session-');
  });
  it('rejects missing exact approval before any network, file read, reservation or signer loading', async () => {
    const test = fixture(); const args = purchase.filter((value, index) => value !== '--approve-atomic-amount' && purchase[index - 1] !== '--approve-atomic-amount');
    expect(await runModeratoCli(args, test.dependencies)).toBe(1);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'explicit-approval-required' });
    expect(test.requests).toEqual([]); expect(test.rpcMethods).toEqual([]); expect(test.tokenReads).toEqual([]); expect(test.loadSigner).not.toHaveBeenCalled();
  });
  it('denies a mainnet RPC response before authentication, policy reservation or signer loading', async () => {
    const test = fixture({ chainId: 1 }); expect(await runModeratoCli(purchase, test.dependencies)).toBe(1);
    expect(test.rpcMethods).toEqual(['eth_chainId']); expect(test.requests).toEqual([]); expect(test.tokenReads).toEqual([]); expect(test.loadSigner).not.toHaveBeenCalled();
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'wrong-rpc-chain' });
  });
  it('denies a changed catalog price without loading a signer or broadening allowance', async () => {
    const test = fixture({ providers: [{ ...provider, atomicPrice: '1001' }] }); expect(await runModeratoCli(purchase, test.dependencies)).toBe(1);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'price-approval-mismatch' });
    expect(test.loadSigner).not.toHaveBeenCalled(); expect(test.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each([{ budgets: [] }, { budgets: [{ ...budget, allowance: '5000', reserved: '1000', spent: '3500' }] }])('requires the existing sufficient integer allowance', async ({ budgets }) => {
    const test = fixture({ budgets }); expect(await runModeratoCli(purchase, test.dependencies)).toBe(1);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'allowance-required' });
    expect(test.loadSigner).not.toHaveBeenCalled(); expect(test.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each(['pending', 'unknown'] as const)('denies a new signature for an existing %s provider purchase', async paymentState => {
    const test = fixture({ purchases: [{ ...record, paymentState }] }); expect(await runModeratoCli(purchase, test.dependencies)).toBe(1);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'purchase-unresolved' }); expect(test.loadSigner).not.toHaveBeenCalled();
    expect(test.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('requires an explicit accessible workspace when account selection is ambiguous', async () => {
    const workspaces = [{ id: workspaceId, name: 'Fixture one', role: 'owner' }, { id: '66000000-0000-4000-8000-000000000006', name: 'Fixture two', role: 'member' }];
    const test = fixture({ workspaces }); expect(await runModeratoCli([...common, ...selection], test.dependencies)).toBe(1);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ code: 'workspace-required' }); expect(test.requests).toHaveLength(1);
    const denied = fixture(); expect(await runModeratoCli([...common, ...selection, '--workspace', workspaces[1]!.id], denied.dependencies)).toBe(1);
    expect(JSON.parse(denied.output[0]!)).toMatchObject({ code: 'workspace-denied' });
    const selected = fixture({ workspaces }); expect(await runModeratoCli([...common, ...selection, '--workspace', workspaceId], selected.dependencies)).toBe(0);
  });
  it('resume uses only the recorded purchase, never loads a signer and prints no private source', async () => {
    const test = fixture(); expect(await runModeratoCli(['--resume', purchaseId, ...common], test.dependencies)).toBe(0);
    expect(test.requests).toEqual([{ method: 'POST', path: `/api/purchases/${purchaseId}/resume`, authorization: 'Bearer synthetic-session-1', body: '{}', paymentCredential: null }]);
    expect(test.loadSigner).not.toHaveBeenCalled(); expect(test.tokenReads).toEqual([tokenFile]);
    expect(JSON.parse(test.output[0]!)).toMatchObject({ operation: 'resume', purchaseId, payment: 'settled', delivery: 'ready', evidence: 'insufficient', passages: 1, outputSaved: false });
    expect(test.output.join('\n')).not.toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL');
  });
  it('saves source only to an explicitly selected new private file and never overwrites an existing file', async () => {
    const outputFile = join(directory, 'new-private-context.json'); createdFiles.push(outputFile);
    const test = fixture(); expect(await runModeratoCli(['--resume', purchaseId, ...common, '--output-file', outputFile], test.dependencies)).toBe(0);
    expect(await readFile(outputFile, 'utf8')).toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL'); expect(test.output.join('\n')).not.toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL');
    const existing = join(directory, 'existing-private-context.json'); createdFiles.push(existing); await writeFile(existing, 'KEEP_EXISTING_FILE');
    const denied = fixture(); expect(await runModeratoCli(['--resume', purchaseId, ...common, '--output-file', existing], denied.dependencies)).toBe(1);
    expect(await readFile(existing, 'utf8')).toBe('KEEP_EXISTING_FILE'); expect(JSON.parse(denied.output[0]!)).toMatchObject({ code: 'output-not-created', purchaseId });
    expect(denied.loadSigner).not.toHaveBeenCalled();
  });
  it('does not expose raw provider, RPC or signer errors in stdout', async () => {
    for (const options of [{ apiError: true }, { rpcError: true }, {}]) {
      const test = fixture(options); expect(await runModeratoCli(purchase, test.dependencies)).toBe(1);
      expect(test.output.join('\n')).not.toContain('SYNTHETIC_SENSITIVE_'); expect(test.output.join('\n')).not.toContain('synthetic-session-');
    }
  });
  it('rejects signer flags on resume/check, conflicting modes, duplicate options and non-integer approvals', () => {
    expect(() => parseModeratoOptions(['--resume', purchaseId, ...common, '--key-file', keyFile])).toThrow('Resume accepts');
    expect(() => parseModeratoOptions(['--check', ...common, ...selection, '--key-file', keyFile])).toThrow('Check accepts');
    expect(() => parseModeratoOptions(['--check', '--purchase', ...common, ...selection])).toThrow('Choose check');
    expect(() => parseModeratoOptions([...common, ...selection, '--provider', providerId])).toThrow('Supply each flag once');
    const fractional = purchase.map(value => value === '1000' ? '0.001' : value);
    expect(() => parseModeratoOptions(fractional)).toThrow('canonical integer');
  });
  it('rejects secret key and private output paths inside the checkout', () => {
    const localFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../.atlas/do-not-create.txt');
    expect(() => parseModeratoOptions(purchase.map(value => value === keyFile ? localFile : value))).toThrow('outside the checkout');
    expect(() => parseModeratoOptions(['--resume', purchaseId, ...common, '--output-file', localFile])).toThrow('outside the checkout');
  });
  it('actual Node entrypoint supports help and fails with no arguments without any live operation', async () => {
    const script = fileURLToPath(new URL('../../packages/sdk/examples/moderato.ts', import.meta.url));
    const run = promisify(execFile);
    const help = await run(process.execPath, ['--experimental-transform-types', script, '--help']);
    expect(help.stdout).toContain('--resume PURCHASE-UUID'); expect(help.stdout).toContain('this example never changes it');
    const missing = await run(process.execPath, ['--experimental-transform-types', script]).catch(error => error as { code: number; stdout: string; stderr: string });
    expect(missing).toMatchObject({ code: 1 }); expect(JSON.parse(missing.stdout.trim())).toMatchObject({ code: 'origin-required', status: 'failed' });
  });
});
