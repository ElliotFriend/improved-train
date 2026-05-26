import {
    Networks,
    TransactionBuilder,
    rpc,
    xdr,
    StrKey,
    scValToNative,
} from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';
import {
    A2A_NURSE_PUBLIC,
    A2A_NETWORK,
    A2A_AMOUNT_STROOPS,
    A2A_POOL_CONTRACT_ID,
    A2A_ASP_MEMBERSHIP_ID,
    A2A_ASP_NON_MEMBERSHIP_ID,
    A2A_NURSE_NOTE_PUBKEY,
    A2A_NURSE_ENC_PUBKEY,
    A2A_NURSE_ENC_PRIVKEY,
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
    nurseEncPrivkey: A2A_NURSE_ENC_PRIVKEY,
};

const nurseEncPrivkeyBytes = parseOptional32Hex(config.nurseEncPrivkey);
const expectedAmountStroops = (() => {
    try {
        return BigInt(config.amountStroops);
    } catch {
        return null;
    }
})();

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
 * Always-on, no privkeys required (on-chain shape checks):
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
 * Additionally, when A2A_NURSE_ENC_PRIVKEY is configured:
 *   - one of encrypted_output{0,1} decrypts under the nurse's X25519
 *     encryption privkey (X25519 + XSalsa20-Poly1305, matching the upstream
 *     Rust `encrypt_output_note`)
 *   - the decrypted amount equals config.amountStroops
 *
 * Residual gap (would require a Poseidon2-BN254 port in Node — TODO):
 *   - a hostile patient client could encrypt the right (amount, blinding) for
 *     the nurse in the *blob*, but commit to a different recipient note pubkey
 *     in the on-chain *commitment*. Decryption + amount check would still
 *     pass, but the nurse couldn't actually spend the output note. No funds
 *     are stolen — just a free consult. Closing this gap requires recomputing
 *     Poseidon2(amount, nurseNotePub, blinding) and comparing to
 *     proof.output_commitmentN from the args.
 *
 * Fundamentally unverifiable by design (privacy-pool property):
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

        if (nurseEncPrivkeyBytes) {
            if (expectedAmountStroops === null) {
                return {
                    ok: false,
                    reason: `A2A_AMOUNT_STROOPS is not a parseable bigint: ${config.amountStroops}`,
                };
            }
            const dec0 = decryptOutputNote(nurseEncPrivkeyBytes, extDataNative.encrypted_output0);
            const dec1 = decryptOutputNote(nurseEncPrivkeyBytes, extDataNative.encrypted_output1);
            const matches = [dec0, dec1].filter((d): d is DecryptedNote => d !== null);
            if (matches.length === 0) {
                return {
                    ok: false,
                    reason: 'neither encrypted_output decrypts for the nurse',
                };
            }
            if (matches.length > 1) {
                // Both decrypt → patient sent both outputs to the nurse. The
                // patient should have at least one change output for
                // themselves; matching shape is (need, change). Treat as a
                // misuse.
                return {
                    ok: false,
                    reason: 'both encrypted_outputs decrypt for the nurse (expected only one)',
                };
            }
            const nurseOutput = matches[0];
            if (nurseOutput.amountStroops !== expectedAmountStroops) {
                return {
                    ok: false,
                    reason: `paid amount ${nurseOutput.amountStroops} stroops, expected ${expectedAmountStroops}`,
                };
            }
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

interface DecryptedNote {
    amountStroops: bigint;
    blinding: Uint8Array;
}

/**
 * Decrypt an `encrypted_output` blob with the recipient's X25519 private key.
 *
 * Mirrors `decrypt_output_note` in the upstream
 * `app/crates/core/prover/src/encryption.rs`:
 *
 *   layout: ephemeral_pubkey (32) || nonce (24) || ciphertext+tag (>=56)
 *   shared = X25519(privkey, ephemeral_pubkey)
 *   plaintext = XSalsa20Poly1305_open(key=shared, nonce, ciphertext)
 *   plaintext = amount (8 LE u64) || blinding (32 LE BN254 Fr)
 *
 * Note that this is *not* NaCl crypto_box, which would apply an additional
 * HSalsa20 mixing step on the ECDH output. The upstream uses the raw shared
 * secret directly as the XSalsa20-Poly1305 key, so we do the same — tweetnacl's
 * `scalarMult` gives us the X25519 product, `secretbox.open` does the AEAD.
 *
 * Returns null if the ciphertext is too short, malformed, or addressed to a
 * different recipient (AEAD tag mismatch).
 */
function decryptOutputNote(nurseEncPriv: Uint8Array, encrypted: Uint8Array): DecryptedNote | null {
    if (encrypted.length < 112) return null;
    const ephemeralPubkey = encrypted.subarray(0, 32);
    const nonce = encrypted.subarray(32, 56);
    const ciphertextWithTag = encrypted.subarray(56);

    let shared: Uint8Array;
    try {
        shared = nacl.scalarMult(nurseEncPriv, ephemeralPubkey);
    } catch {
        return null;
    }

    const plaintext = nacl.secretbox.open(ciphertextWithTag, nonce, shared);
    if (!plaintext) return null;
    if (plaintext.length !== 40) return null;

    let amount = 0n;
    for (let i = 7; i >= 0; i--) {
        amount = (amount << 8n) | BigInt(plaintext[i]);
    }
    const blinding = plaintext.slice(8, 40);

    return { amountStroops: amount, blinding };
}

function parseOptional32Hex(raw: string | undefined): Uint8Array | null {
    if (!raw || raw.trim() === '') return null;
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (hex.length !== 64) return null;
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
}
