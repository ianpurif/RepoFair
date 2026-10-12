import { Credential, Receipt } from 'mppx';
import { createPublicClient, decodeFunctionData, http, keccak256, parseEventLogs, stringToHex } from 'viem';
import type { PublicClient } from 'viem';
import { Abis, Transaction } from 'viem/tempo';
import { tempoModerato } from 'viem/tempo/chains';
import type { PurchaseTerms } from '../../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../../packages/contracts/src/commerce.ts';
import { assertApprovedChallenge } from '../../../packages/sdk/src/payment-policy.ts';
import type { ApprovedTestnetPurchase } from '../../../packages/sdk/src/payment-policy.ts';

export type PaymentSubmission = Readonly<{ challengeId: string; realm: string; transactionHash: `0x${string}`; sender: `0x${string}` }>;
/** Layout verified against pinned mppx 0.13.1; no SDK private imports. */
export function challengeMemoMatches(memo: string, realm: string, challengeId: string): boolean {
  if (!/^0x[a-fA-F0-9]{64}$/.test(memo)) return false;
  const raw = memo.toLowerCase();
  return raw.slice(0,10) === keccak256(stringToHex('mpp')).slice(0,10) && raw.slice(10,12) === '01'
    && raw.slice(12,32) === keccak256(stringToHex(realm)).slice(2,22) && raw.slice(52,66) === keccak256(stringToHex(challengeId)).slice(2,16);
}
/** Inspect and persist this binding before handing the credential to a broadcaster. No raw credential is stored. */
export async function inspectPaymentCredential(serialized: string, approval: ApprovedTestnetPurchase, now: number): Promise<PaymentSubmission> {
  if (typeof serialized !== 'string' || serialized.length > 32_768) throw new Error('Invalid bounded payment credential');
  const credential = Credential.deserialize<{ type: string; signature?: string }>(serialized);
  assertApprovedChallenge(credential.challenge,approval,approval.terms.requestDigest,now,`${approval.origin}/context/retrieve`);
  if (credential.payload?.type !== 'transaction' || typeof credential.payload.signature !== 'string' || !/^0x76[a-fA-F0-9]+$/.test(credential.payload.signature)) throw new Error('Only unsigned-broadcast Tempo pull credentials are supported');
  const transaction = Transaction.deserialize(credential.payload.signature as `0x76${string}`);
  if (transaction.chainId !== 42431 || !transaction.from || !transaction.signature || transaction.signature.type === 'keychain'
    || transaction.feePayerSignature !== undefined || transaction.keyAuthorization || transaction.calls.length !== 1
    || (transaction.validBefore !== undefined && (transaction.validBefore > Math.floor(approval.terms.expiresAtMs / 1000) || transaction.validBefore <= Math.floor(now / 1000)))) throw new Error('Unsupported or incorrect-network transaction');
  const call = transaction.calls[0]!;
  if (!call.to || call.to.toLowerCase() !== approval.terms.token.toLowerCase() || !call.data || (call.value !== undefined && call.value !== 0n)) throw new Error('Payment call differs from approved token');
  const decoded = decodeFunctionData({abi:Abis.tip20,data:call.data});
  if (decoded.functionName !== 'transferWithMemo') throw new Error('Challenge-attributed transfer is required');
  const [recipient,amount,memo] = decoded.args;
  if (recipient.toLowerCase() !== approval.terms.recipient.toLowerCase() || amount.toString() !== approval.terms.atomicAmount
    || !challengeMemoMatches(memo,approval.realm,approval.challengeId)) throw new Error('Payment recipient, amount or challenge attribution differs from approval');
  // The pinned SDK normalizes the envelope before broadcasting; use that exact canonical hash.
  const canonical = await Transaction.serialize(transaction);
  return {challengeId:approval.challengeId,realm:approval.realm,transactionHash:keccak256(canonical),sender:transaction.from.toLowerCase() as `0x${string}`};
}
export function createModeratoClient(rpcUrl: string | undefined): PublicClient {
  if (!rpcUrl) throw new Error('Tempo Moderato RPC is not configured');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Tempo RPC must use HTTPS without credentials');
  return createPublicClient({chain:tempoModerato,transport:http(url.href,{retryCount:0,timeout:8000})}) as PublicClient;
}
/** Reconcile remote chain identity, canonical inclusion and the exact challenge-attributed transfer. */
export async function verifyModeratoSettlement(client: PublicClient, terms: PurchaseTerms, receipt: Receipt.Receipt, submission: PaymentSubmission): Promise<boolean> {
  try {
    const parsed = Receipt.Schema.parse(receipt);
    if (terms.network !== MODERATO_NETWORK || terms.token.toLowerCase() !== MODERATO_PATHUSD || client.chain?.id !== 42431
      || parsed.method !== 'tempo' || parsed.status !== 'success' || !/^0x[a-fA-F0-9]{64}$/.test(parsed.reference)
      || parsed.reference.toLowerCase() !== submission.transactionHash.toLowerCase() || await client.getChainId() !== 42431) return false;
    const hash = submission.transactionHash;
    const [transaction,settled] = await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash})]);
    if (transaction.hash.toLowerCase() !== hash || transaction.chainId !== 42431 || transaction.from.toLowerCase() !== submission.sender
      || settled.status !== 'success' || settled.transactionHash.toLowerCase() !== hash || settled.from.toLowerCase() !== submission.sender) return false;
    const block = await client.getBlock({blockNumber:settled.blockNumber});
    if (block.hash !== settled.blockHash) return false;
    const logs = parseEventLogs({abi:Abis.tip20,eventName:'TransferWithMemo',logs:settled.logs,strict:true});
    const matching = logs.filter(log => log.address.toLowerCase() === terms.token.toLowerCase() && log.args.from.toLowerCase() === submission.sender
      && log.args.to.toLowerCase() === terms.recipient.toLowerCase() && log.args.amount.toString() === terms.atomicAmount
      && challengeMemoMatches(log.args.memo,submission.realm,submission.challengeId));
    return matching.length === 1;
  } catch { return false; }
}
