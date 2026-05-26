import {
    Networks,
    TransactionBuilder,
    rpc,
    xdr,
    StrKey,
    scValToNative,
} from '@stellar/stellar-sdk';
import {
    A2A_NURSE_PUBLIC,
    A2A_NETWORK,
    A2A_AMOUNT_STROOPS,
    A2A_POOL_CONTRACT_ID,
    A2A_ASP_MEMBERSHIP_ID,
    A2A_ASP_NON_MEMBERSHIP_ID,
    A2A_NURSE_NOTE_PUBKEY,
    A2A_NURSE_ENC_PUBKEY,
} from '$env/static/private';

export const config = {
    nursePublic: A2A_NURSE_PUBLIC,
    network: A2A_NETWORK,
    amountStroops: A2A_AMOUNT_STROOPS,
    poolContractId: A2A_POOL_CONTRACT_ID,
    aspMembershipId: A2A_ASP_MEMBERSHIP_ID,
    aspNonMembershipId: A2A_ASP_NON_MEMBERSHIP_ID,
    nurseNotePubkey: A2A_NURSE_NOTE_PUBKEY,
    nurseEncPubkey: A2A_NURSE_ENC_PUBKEY,
};

const NETWORK_PASSPHRASE = config.network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

const sorobanRpc = new rpc.Server(
    config.network === 'testnet'
        ? 'https://soroban-testnet.stellar.org'
        : 'https://soroban.stellar.org',
);

// Max age (seconds) for a settlement tx the patient submits as proof of
// payment. Long enough to absorb network slowness; short enough that a leaked
// hash isn't useful days later.
const MAX_TX_AGE_SECONDS = 600;

// Per-process set of tx hashes already accepted as payment. Prevents the same
// settlement being reused for two consults. In a real deployment this would be
// a DB; for the demo, in-memory is sufficient — the server restarts rarely and
// stale entries are bounded by MAX_TX_AGE_SECONDS anyway.
const consumedHashes = new Set<string>();

export interface VerifyOk {
    ok: true;
    sender: string;
    ledgerCreatedAt: number;
    ageSeconds: number;
}
export interface VerifyFail {
    ok: false;
    reason: string;
}
export type VerifyResult = VerifyOk | VerifyFail;

/**
 * Verifies a patient-submitted `transact()` settlement against the spp pool.
 *
 * What this checks (all from on-chain data, no privkeys required):
 *   - RPC reports the tx SUCCESS, exists, and isn't older than MAX_TX_AGE_SECONDS
 *   - hash hasn't been consumed by a previous consult on this process
 *   - single InvokeContract op targeting our configured pool
 *   - function name is `transact` (not `withdraw`, `register_asp_root`, etc.)
 *   - ext_data.ext_amount == 0 (no piggybacked public withdraw)
 *   - ext_data.recipient == pool contract id (our placeholder convention; see
 *     README — putting any other address there is fine on-chain but would
 *     identify the recipient to anyone reading the schema)
 *   - both encrypted_output payloads are non-empty
 *   - sender arg is a valid Stellar account string
 *
 * What this does NOT verify (intentionally — would require the nurse's
 * encryption private key, which lives in OPFS in the nurse's browser):
 *   - the actual amount paid to the nurse (in the encrypted output)
 *   - that an output is encrypted to the nurse's note pubkey
 *
 * What is fundamentally unverifiable by design (privacy-pool property):
 *   - the identity of the patient. The `sender` arg names the broadcaster
 *     (who could be any relayer in a production design); the pool itself
 *     hides the link between input notes and the original depositor.
 */
export async function verifyPayment(hash: string): Promise<VerifyResult> {
    try {
        if (consumedHashes.has(hash)) {
            return { ok: false, reason: 'tx hash already consumed (replay)' };
        }

        const deadline = Date.now() + 10_000;
        let result = await sorobanRpc.getTransaction(hash);
        while (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 750));
            result = await sorobanRpc.getTransaction(hash);
        }
        if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
            return { ok: false, reason: 'tx not found on RPC within 10s' };
        }
        if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
            return { ok: false, reason: `tx status: ${result.status}` };
        }

        const createdAt = Number(result.createdAt ?? 0);
        if (!Number.isFinite(createdAt) || createdAt === 0) {
            return { ok: false, reason: 'tx createdAt missing on RPC response' };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const ageSeconds = nowSec - createdAt;
        if (ageSeconds > MAX_TX_AGE_SECONDS) {
            return {
                ok: false,
                reason: `tx is ${ageSeconds}s old (max ${MAX_TX_AGE_SECONDS}s)`,
            };
        }
        if (ageSeconds < -60) {
            return { ok: false, reason: `tx createdAt is ${-ageSeconds}s in the future` };
        }

        const tx = TransactionBuilder.fromXDR(result.envelopeXdr, NETWORK_PASSPHRASE);
        const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
        if (inner.operations.length !== 1) {
            return { ok: false, reason: `expected 1 op, got ${inner.operations.length}` };
        }
        const op = inner.operations[0];
        if (op.type !== 'invokeHostFunction') {
            return { ok: false, reason: `op type ${op.type}, expected invokeHostFunction` };
        }
        if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') {
            return { ok: false, reason: 'host function is not InvokeContract' };
        }

        const invoke = op.func.invokeContract();
        const contractAddr = invoke.contractAddress();
        if (contractAddr.switch().name !== 'scAddressTypeContract') {
            return { ok: false, reason: 'contract address kind is not Contract' };
        }
        const targeted = StrKey.encodeContract(
            Buffer.from(contractAddr.contractId() as unknown as Uint8Array),
        );
        if (targeted !== config.poolContractId) {
            return {
                ok: false,
                reason: `tx targets ${targeted}, expected pool ${config.poolContractId}`,
            };
        }

        const fnName = invoke.functionName().toString();
        if (fnName !== 'transact') {
            return { ok: false, reason: `function ${fnName}, expected transact` };
        }

        const args = invoke.args();
        if (args.length !== 3) {
            return {
                ok: false,
                reason: `expected 3 args (proof, ext_data, sender), got ${args.length}`,
            };
        }

        // args[0] is the SNARK proof struct — the on-chain verifier already
        // enforces its validity; nothing to recheck here.
        const extDataNative = decodeExtData(args[1]);
        if (!extDataNative) {
            return { ok: false, reason: 'ext_data could not be decoded as a struct' };
        }

        if (extDataNative.recipient !== config.poolContractId) {
            return {
                ok: false,
                reason: `ext_data.recipient ${extDataNative.recipient}, expected pool placeholder ${config.poolContractId}`,
            };
        }
        if (extDataNative.ext_amount !== 0n) {
            return {
                ok: false,
                reason: `ext_data.ext_amount=${extDataNative.ext_amount}, expected 0 (no piggybacked withdraw)`,
            };
        }
        if (extDataNative.encrypted_output0.length === 0) {
            return { ok: false, reason: 'ext_data.encrypted_output0 is empty' };
        }
        if (extDataNative.encrypted_output1.length === 0) {
            return { ok: false, reason: 'ext_data.encrypted_output1 is empty' };
        }

        const senderNative = scValToNative(args[2]);
        const sender = typeof senderNative === 'string' ? senderNative : '';
        if (!sender.startsWith('G') || !StrKey.isValidEd25519PublicKey(sender)) {
            return {
                ok: false,
                reason: `sender arg is not a valid Stellar account: ${String(senderNative)}`,
            };
        }

        consumedHashes.add(hash);
        return { ok: true, sender, ledgerCreatedAt: createdAt, ageSeconds };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
}

interface DecodedExtData {
    encrypted_output0: Uint8Array;
    encrypted_output1: Uint8Array;
    ext_amount: bigint;
    recipient: string;
}

function decodeExtData(scv: xdr.ScVal): DecodedExtData | null {
    const native = scValToNative(scv);
    if (!native || typeof native !== 'object' || Array.isArray(native)) return null;
    const obj = native as Record<string, unknown>;

    const enc0 = obj.encrypted_output0;
    const enc1 = obj.encrypted_output1;
    const extAmount = obj.ext_amount;
    const recipient = obj.recipient;

    if (!(enc0 instanceof Uint8Array) || !(enc1 instanceof Uint8Array)) return null;
    if (typeof recipient !== 'string') return null;
    let extAmountBig: bigint;
    if (typeof extAmount === 'bigint') {
        extAmountBig = extAmount;
    } else if (typeof extAmount === 'number' || typeof extAmount === 'string') {
        try {
            extAmountBig = BigInt(extAmount);
        } catch {
            return null;
        }
    } else {
        return null;
    }

    return {
        encrypted_output0: enc0,
        encrypted_output1: enc1,
        ext_amount: extAmountBig,
        recipient,
    };
}
