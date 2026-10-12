import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/tempo/chains';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../contracts/src/commerce.ts';
import type { CatalogProvider, PurchaseBudget } from '../../contracts/src/index.ts';
import { RepoFairApiError, AuthenticatedRepoFairClient } from '../src/index.ts';
import type { ModeratoSigner, PaidKnowledge } from '../src/authenticated.ts';
import { atomicToDecimal } from '../src/payment-policy.ts';

/** Caller-owned example: it never reads application env files or generates/funds a wallet. */
export const MODERATO_RPC = 'https://rpc.moderato.tempo.xyz';
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const maximumAtomic = (1n << 256n) - 1n;
const usage = `Run from the checkout with Node 22:
node --experimental-transform-types packages/sdk/examples/moderato.ts --check --origin https://repofair.vercel.app --token-file C:\\secure\\clerk-session.jwt --provider PROVIDER-UUID --question "Your source question"

Modes (default: --check):
  --check                 Read RPC chain, account, accessible catalog and existing allowance only.
  --purchase              Requires --approve-atomic-amount PRICE, --key-file PATH and --idempotency-key KEY.
  --resume PURCHASE-UUID  Reconcile existing delivery; no signing key or new payment credential.

Common: --origin EXACT-HTTPS-ORIGIN, --token-file ABSOLUTE-PATH
Check/purchase: --provider UUID, --question TEXT, --workspace UUID (required if account has multiple workspaces)
Purchase: --approve-atomic-amount INTEGER, --key-file ABSOLUTE-PATH-OUTSIDE-CHECKOUT,
          --idempotency-key STABLE-KEY (16-128 letters, digits, underscore or hyphen)
Purchase/resume: --output-file ABSOLUTE-PATH-OUTSIDE-CHECKOUT (exclusive creation of private result)
Local RepoFair only: --allow-local-development permits an explicit loopback HTTP origin.

RPC is fixed to Moderato 42431. PathUSD has six decimals: 1000 atomic units = 0.001000 PathUSD.
Configure the workspace allowance in RepoFair first; this example never changes it.
Refresh the caller-owned Clerk session-token file when it expires; it is reread per API request.
Check results do not verify a real signature, gas funding, settlement or paid delivery.
After an interrupted purchase, use --resume with the printed purchase ID; never sign a replacement.
Keep key/token/output files access-controlled and outside application settings. Do not paste their contents into commands or logs.`;

class CliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new CliError(code, message);
}
function uuid(value: string | undefined): string {
  requireValue(value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value), 'invalid-id', 'Use a RepoFair UUID.');
  return value.toLowerCase();
}
function integer(value: unknown, positive = false): bigint {
  requireValue(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(value), 'invalid-amount', 'Use canonical integer token units.');
  const amount = BigInt(value);
  requireValue(amount <= maximumAtomic && (!positive || amount > 0n), 'invalid-amount', 'Use bounded positive token units.');
  return amount;
}
function absoluteFile(value: string | undefined, outsideCheckout = false): string {
  requireValue(value && isAbsolute(value), 'absolute-file-required', 'Use an absolute file path.');
  const file = resolve(value);
  if (outsideCheckout) {
    const path = relative(checkout, file);
    requireValue(path.startsWith(`..${sep}`) || isAbsolute(path), 'file-in-checkout', 'Keep signing keys and private output outside the checkout.');
  }
  return file;
}
type Common = Readonly<{ origin: string; tokenFile: string; allowLocalDevelopment: boolean; outputFile?: string }>;
type Selection = Readonly<{ providerId: string; question: string; workspaceId?: string }>;
export type ModeratoOptions = Common & (
  | (Selection & Readonly<{ mode: 'check' }>)
  | (Selection & Readonly<{ mode: 'purchase'; approvedAtomicAmount: string; keyFile: string; idempotencyKey: string }>)
  | Readonly<{ mode: 'resume'; purchaseId: string }>
);

export function parseModeratoOptions(args: readonly string[]): ModeratoOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const flags = new Set(['--origin', '--token-file', '--provider', '--question', '--workspace', '--approve-atomic-amount', '--key-file', '--idempotency-key', '--output-file', '--resume']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    requireValue(!values.has(flag) && !switches.has(flag), 'duplicate-flag', 'Supply each flag once.');
    if (['--check', '--purchase', '--allow-local-development'].includes(flag)) { switches.add(flag); continue; }
    const value = args[++i];
    requireValue(flags.has(flag) && value && !value.startsWith('--'), 'invalid-flag', 'Use --help for supported flags and required values.');
    values.set(flag, value);
  }
  requireValue(Number(switches.has('--check')) + Number(switches.has('--purchase')) + Number(values.has('--resume')) <= 1, 'conflicting-modes', 'Choose check, purchase or resume.');
  const mode = values.has('--resume') ? 'resume' : switches.has('--purchase') ? 'purchase' : 'check';
  const origin = values.get('--origin');
  requireValue(origin, 'origin-required', 'Supply the exact RepoFair HTTPS origin.');
  const common: Common = { origin, tokenFile: absoluteFile(values.get('--token-file')), allowLocalDevelopment: switches.has('--allow-local-development'),
    ...(values.has('--output-file') ? { outputFile: absoluteFile(values.get('--output-file'), true) } : {}) };
  const purchaseFlags = ['--approve-atomic-amount', '--key-file', '--idempotency-key'];
  if (mode === 'resume') {
    requireValue(!['--provider', '--question', '--workspace', ...purchaseFlags].some(flag => values.has(flag)), 'resume-does-not-sign', 'Resume accepts a purchase ID and no new purchase or signer settings.');
    return { ...common, mode, purchaseId: uuid(values.get('--resume')) };
  }
  const question = values.get('--question');
  requireValue(typeof question === 'string' && question.trim() && question.length <= 2000, 'question-required', 'Supply a source question of 1-2000 characters.');
  const selection: Selection = { providerId: uuid(values.get('--provider')), question: question.trim(),
    ...(values.has('--workspace') ? { workspaceId: uuid(values.get('--workspace')) } : {}) };
  if (mode === 'check') {
    requireValue(!purchaseFlags.some(flag => values.has(flag)) && !common.outputFile, 'check-does-not-sign', 'Check accepts no approval, signing key or output file.');
    return { ...common, ...selection, mode };
  }
  const approvedAtomicAmount = values.get('--approve-atomic-amount');
  requireValue(approvedAtomicAmount, 'explicit-approval-required', 'Purchase requires --approve-atomic-amount with the exact displayed integer price.');
  integer(approvedAtomicAmount, true);
  const idempotencyKey = values.get('--idempotency-key');
  requireValue(idempotencyKey && /^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey), 'idempotency-key-required', 'Supply a stable idempotency key for this exact purchase.');
  return { ...common, ...selection, mode, approvedAtomicAmount, idempotencyKey, keyFile: absoluteFile(values.get('--key-file'), true) };
}

async function readBoundedText(file: string, maximum: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'invalid-credential-file', 'Credential file must be a bounded regular text file.');
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead > 0 && bytesRead <= maximum, 'invalid-credential-file', 'Credential file exceeds its size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)).trim();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('credential-file-unavailable', 'Credential file cannot be read as bounded UTF-8 text.');
  } finally { await handle?.close(); }
}
async function signerFromFile(file: string, rpcFetch: typeof fetch): Promise<ModeratoSigner> {
  let actual: string;
  try { actual = await realpath(file); } catch { throw new CliError('credential-file-unavailable', 'Signing key file is unavailable.'); }
  absoluteFile(actual, true);
  const key = await readBoundedText(actual, 128);
  requireValue(/^0x[a-fA-F0-9]{64}$/.test(key), 'invalid-signing-key', 'Signing key file must contain an existing hex private key.');
  try {
    const account = privateKeyToAccount(key as `0x${string}`);
    const client = createWalletClient({ account, chain: tempoModerato, transport: http(MODERATO_RPC, { fetchFn: rpcFetch, retryCount: 0, timeout: 10_000, fetchOptions: { redirect: 'error' } }) });
    return { account, getClient: () => client };
  } catch { throw new CliError('invalid-signing-key', 'Signing key cannot initialize the caller-owned Moderato account.'); }
}
function providerTerms(provider: CatalogProvider): void {
  requireValue(provider.network === MODERATO_NETWORK && provider.token.toLowerCase() === MODERATO_PATHUSD && provider.tokenDecimals === 6, 'unsupported-network', 'Only Moderato PathUSD terms are supported.');
  integer(provider.atomicPrice, true);
  requireValue(/^0x[a-fA-F0-9]{40}$/.test(provider.recipient) && !/^0x0{40}$/i.test(provider.recipient), 'invalid-recipient', 'Provider recipient is invalid.');
  const endpoint = new URL(provider.endpoint);
  requireValue(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && endpoint.pathname === '/context/retrieve' && !endpoint.search && !endpoint.hash, 'invalid-provider-route', 'Provider must use its exact HTTPS context route.');
}
function availableBudget(budgets: readonly PurchaseBudget[]): PurchaseBudget | undefined {
  const matching = budgets.filter(budget => budget.network === MODERATO_NETWORK && budget.token.toLowerCase() === MODERATO_PATHUSD);
  requireValue(matching.length <= 1, 'invalid-budget', 'Workspace budget response is ambiguous.');
  const budget = matching[0];
  if (budget) {
    const allowance = integer(budget.allowance), reserved = integer(budget.reserved), spent = integer(budget.spent);
    requireValue(reserved + spent <= allowance, 'invalid-budget', 'Workspace budget response is invalid.');
  }
  return budget;
}
function summary(result: PaidKnowledge): Record<string, unknown> {
  return { purchaseId: result.purchase.id, payment: result.purchase.paymentState, delivery: result.purchase.deliveryState,
    evidence: result.context.evidenceState, passages: result.context.evidence.length, nodes: result.context.nodes.length, edges: result.context.edges.length };
}
async function savePrivateResult(file: string, result: PaidKnowledge): Promise<void> {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8');
  } catch { throw new CliError('output-not-created', 'Output could not be created exclusively. The purchase is recorded; resume it without signing again.'); }
  finally { await handle?.close(); }
}
export type ModeratoDependencies = Readonly<{
  atlasFetch?: typeof fetch; rpcFetch?: typeof fetch;
  /** Tests supply synthetic file/signing transports; production defaults remain caller-owned. */
  readText?: typeof readBoundedText;
  loadSigner?: (file: string, rpcFetch: typeof fetch) => Promise<ModeratoSigner>;
  stdout?: (value: string) => void;
}>;

/** No automatic purchases, allowance changes, wallet funding or fallback RPCs. */
export async function runModeratoCli(args: readonly string[], dependencies: ModeratoDependencies = {}): Promise<number> {
  const write = dependencies.stdout ?? (value => process.stdout.write(value + '\n'));
  if (args.length === 1 && args[0] === '--help') { write(usage); return 0; }
  let operation = 'check';
  let purchaseId: string | undefined;
  try {
    const options = parseModeratoOptions(args); operation = options.mode;
    const read = dependencies.readText ?? readBoundedText;
    const rpcFetch = dependencies.rpcFetch ?? globalThis.fetch.bind(globalThis);
    const api = new AuthenticatedRepoFairClient(options.origin, { allowLocalDevelopment: options.allowLocalDevelopment,
      ...(dependencies.atlasFetch ? { fetch: dependencies.atlasFetch } : {}), sessionToken: async () => {
        const token = await read(options.tokenFile, 16_384);
        requireValue(token && !/\s/.test(token), 'invalid-session-file', 'Session-token file must contain one current token.'); return token;
      } });
    const rpc = createPublicClient({ chain: tempoModerato, transport: http(MODERATO_RPC, { fetchFn: rpcFetch, retryCount: 0, timeout: 10_000, fetchOptions: { redirect: 'error' } }) });
    requireValue(await rpc.getChainId() === 42431, 'wrong-rpc-chain', 'RPC is not Moderato 42431; no reservation or signing is permitted.');
    if (options.mode === 'resume') {
      purchaseId = options.purchaseId;
      const result = await api.resumePurchase(options.purchaseId);
      if (options.outputFile) await savePrivateResult(options.outputFile, result);
      write(JSON.stringify({ mode: 'tempo-testnet', operation, ...summary(result), outputSaved: !!options.outputFile })); return 0;
    }
    const account = await api.account();
    requireValue(account.authenticated === true && Array.isArray(account.workspaces), 'account-unavailable', 'Authenticated RepoFair account is required.');
    const workspaceId = options.workspaceId ?? (account.workspaces.length === 1 ? account.workspaces[0]?.id : undefined);
    requireValue(workspaceId, 'workspace-required', 'Supply --workspace when the account has multiple workspaces, or create one in RepoFair first.');
    requireValue(account.workspaces.some(workspace => workspace.id.toLowerCase() === workspaceId.toLowerCase()), 'workspace-denied', 'The selected workspace is not accessible to this account.');
    const selectedWorkspace = uuid(workspaceId);
    const provider = (await api.catalog()).providers.find(item => item.id.toLowerCase() === options.providerId);
    requireValue(provider, 'provider-unavailable', 'The exact provider is not accessible in this account catalog.');
    providerTerms(provider);
    const history = await api.purchaseHistory(selectedWorkspace);
    const budget = availableBudget(history.budgets);
    const remaining = budget ? integer(budget.allowance) - integer(budget.reserved) - integer(budget.spent) : 0n;
    const unresolved = history.purchases.filter(purchase => purchase.providerId.toLowerCase() === options.providerId && ['pending', 'unknown'].includes(purchase.paymentState)).map(purchase => purchase.id);
    if (options.mode === 'check') {
      write(JSON.stringify({ mode: 'tempo-testnet', operation, readOnly: true, chainId: 42431, authenticated: true,
        workspaceId: selectedWorkspace, providerId: options.providerId, atomicPrice: provider.atomicPrice, pricePathUsd: atomicToDecimal(provider.atomicPrice, 6),
        allowance: budget?.allowance ?? null, reserved: budget?.reserved ?? '0', spent: budget?.spent ?? '0', remaining: remaining.toString(),
        unresolvedPurchaseIds: unresolved, signing: 'unverified', settlement: 'unverified', gasFunding: 'unverified' })); return 0;
    }
    requireValue(options.approvedAtomicAmount === provider.atomicPrice, 'price-approval-mismatch', 'Exact provider price differs from your explicit integer approval; no purchase was reserved.');
    requireValue(unresolved.length === 0, 'purchase-unresolved', 'Resume the existing pending or unknown provider purchase before approving another.');
    requireValue(budget && remaining >= integer(provider.atomicPrice, true), 'allowance-required', 'Set a sufficient workspace allowance in RepoFair first; this example cannot broaden it.');
    // Load only after exact approval and current read-only policy checks. No signature is created here.
    const signer = await (dependencies.loadSigner ?? signerFromFile)(options.keyFile, rpcFetch);
    const reservation = await api.approvePurchase({ workspaceId: selectedWorkspace, providerId: options.providerId, question: options.question,
      idempotencyKey: options.idempotencyKey, approvedAtomicAmount: options.approvedAtomicAmount });
    purchaseId = reservation.purchase.id;
    write(JSON.stringify({ mode: 'tempo-testnet', operation, purchaseId, payment: reservation.purchase.paymentState, status: 'recorded', nextAction: 'Resume this purchase if interrupted; do not sign a replacement.' }));
    requireValue(reservation.purchase.paymentState === 'reserved', 'purchase-already-recorded', 'This purchase already has a payment state; resume it without another signature.');
    const result = await api.pay(reservation, signer);
    if (options.outputFile) await savePrivateResult(options.outputFile, result);
    write(JSON.stringify({ mode: 'tempo-testnet', operation, ...summary(result), outputSaved: !!options.outputFile })); return 0;
  } catch (error) {
    const safe = error instanceof CliError ? { code: error.code, message: error.message }
      : error instanceof RepoFairApiError ? { code: error.code, httpStatus: error.status }
        : { code: 'operation-unavailable', message: 'Operation failed. Credentials, RPC details and private source are omitted.' };
    write(JSON.stringify({ mode: 'tempo-testnet', operation, status: 'failed', ...safe, ...(purchaseId ? { purchaseId, nextAction: 'Resume this recorded purchase without a signing key; do not sign a replacement.' } : {}) })); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runModeratoCli(process.argv.slice(2));
