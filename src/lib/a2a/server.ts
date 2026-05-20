import {
    Address,
    BASE_FEE,
    Contract,
    Horizon,
    Keypair,
    Networks,
    TransactionBuilder,
    nativeToScVal,
    rpc,
    scValToNative,
    xdr,
} from '@stellar/stellar-sdk';
import { read } from '$app/server';
import * as snarkjs from 'snarkjs';
import {
    A2A_NURSE_PUBLIC,
    A2A_NURSE_SECRET,
    A2A_PRIVACY_POOL_ID,
    A2A_NETWORK,
} from '$env/static/private';

import withdrawalInput from './assets/withdrawal_input.json';
import wasmUrl from './assets/main.wasm?url';
import zkeyUrl from './assets/main_final.zkey?url';

export const config = {
    nursePublic: A2A_NURSE_PUBLIC,
    nurseSecret: A2A_NURSE_SECRET,
    privacyPoolId: A2A_PRIVACY_POOL_ID,
    network: A2A_NETWORK,
    amountXlm: '1', // FIXED_AMOUNT in the contract = 1 XLM
};

const NETWORK_PASSPHRASE =
    config.network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

const horizon = new Horizon.Server(
    config.network === 'testnet'
        ? 'https://horizon-testnet.stellar.org'
        : 'https://horizon.stellar.org',
);

const sorobanRpc = new rpc.Server(
    config.network === 'testnet'
        ? 'https://soroban-testnet.stellar.org'
        : 'https://soroban.stellar.org',
);

// Load the circuit assets once per function instance.
let circuitCache: { wasm: Uint8Array; zkey: Uint8Array } | null = null;
async function loadCircuits() {
    if (!circuitCache) {
        const [wasm, zkey] = await Promise.all([
            read(wasmUrl)
                .arrayBuffer()
                .then((b) => new Uint8Array(b)),
            read(zkeyUrl)
                .arrayBuffer()
                .then((b) => new Uint8Array(b)),
        ]);
        circuitCache = { wasm, zkey };
    }
    return circuitCache;
}

// ---------- Soroban encoding (matches stellar-circom2soroban) ----------
//
// G1Affine bytes:    x (48 BE) || y (48 BE)                        = 96 bytes
// G2Affine bytes:    x.c0 (48 BE) || x.c1 (48 BE)
//                 || y.c0 (48 BE) || y.c1 (48 BE)                  = 192 bytes
// Fr bytes:          32 BE
// Proof.to_bytes:    G1 || G2 || G1                                 = 384 bytes
// PublicSignals.to_bytes: u32_be(len) || Fr * len                   = 4 + n*32

function feBytes(decimal: string, byteLen: number): Uint8Array {
    let hex = BigInt(decimal).toString(16);
    if (hex.length > byteLen * 2) throw new Error(`value too large for ${byteLen} bytes`);
    hex = hex.padStart(byteLen * 2, '0');
    const out = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

interface SnarkjsProof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
}

function encodeProof(proof: SnarkjsProof): Uint8Array {
    const a = concatBytes(feBytes(proof.pi_a[0], 48), feBytes(proof.pi_a[1], 48));
    // For BLS12-381 G2, Fq2 elements are serialized as c1 || c0 (IETF / Zcash
    // convention, which ark_bls12_381 follows). snarkjs writes pi_b[i] as
    // [c0, c1], so we swap when packing.
    const b = concatBytes(
        feBytes(proof.pi_b[0][1], 48),
        feBytes(proof.pi_b[0][0], 48),
        feBytes(proof.pi_b[1][1], 48),
        feBytes(proof.pi_b[1][0], 48),
    );
    const c = concatBytes(feBytes(proof.pi_c[0], 48), feBytes(proof.pi_c[1], 48));
    return concatBytes(a, b, c);
}

function encodePublicSignals(signals: string[]): Uint8Array {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, signals.length, false);
    const frs = signals.map((s) => feBytes(s, 32));
    return concatBytes(len, ...frs);
}

// ---------- Step events for the NDJSON stream ----------

export interface WithdrawProgress {
    step: (label: string, detail?: string) => void;
}

// ---------- Real privacy-pool withdrawal ----------

export async function submitPrivacyPoolWithdraw(
    progress: WithdrawProgress,
): Promise<{ hash: string; ledger: number }> {
    progress.step('Loading circuit assets', 'main.wasm + main_final.zkey');
    const { wasm, zkey } = await loadCircuits();

    progress.step(
        'Generating Groth16 proof (BLS12-381)',
        'snarkjs in-process (witness + prove)',
    );
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        withdrawalInput as unknown as snarkjs.CircuitSignals,
        wasm,
        zkey,
    );

    progress.step('Encoding proof for Soroban verifier');
    const proofBytes = encodeProof(proof as unknown as SnarkjsProof);
    const publicBytes = encodePublicSignals(publicSignals as string[]);

    progress.step(
        'Building withdraw() invocation',
        `pool ${config.privacyPoolId.slice(0, 8)}...  source=nurse (to.require_auth)`,
    );
    const nurse = Keypair.fromSecret(config.nurseSecret);
    const account = await sorobanRpc.getAccount(nurse.publicKey());
    const contract = new Contract(config.privacyPoolId);

    const op = contract.call(
        'withdraw',
        new Address(nurse.publicKey()).toScVal(),
        nativeToScVal(Buffer.from(proofBytes), { type: 'bytes' }),
        nativeToScVal(Buffer.from(publicBytes), { type: 'bytes' }),
    );

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(op)
        .setTimeout(60)
        .build();

    progress.step('Simulating + assembling Soroban auth');
    const prepared = await sorobanRpc.prepareTransaction(tx);
    prepared.sign(nurse);

    progress.step('Broadcasting transaction');
    const send = await sorobanRpc.sendTransaction(prepared);
    if (send.status === 'ERROR') {
        throw new Error(`sendTransaction error: ${JSON.stringify(send.errorResult)}`);
    }

    // Poll until included
    let result = await sorobanRpc.getTransaction(send.hash);
    const deadline = Date.now() + 30_000;
    while (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() > deadline) throw new Error('tx not confirmed within 30s');
        await new Promise((r) => setTimeout(r, 1500));
        result = await sorobanRpc.getTransaction(send.hash);
    }

    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`tx failed: ${result.status}`);
    }

    // The withdraw() contract returns Vec<String>: empty = success, non-empty = error msg
    const returned = scValToNative(result.returnValue as xdr.ScVal) as string[] | undefined;
    if (Array.isArray(returned) && returned.length > 0) {
        throw new Error(`pool rejected withdraw: ${returned.join(', ')}`);
    }

    return { hash: send.hash, ledger: result.ledger };
}

// ---------- Settlement verification ----------

/**
 * Confirms a settlement tx on Horizon: must be successful and signed by the
 * nurse account (since nurse-as-source is what to.require_auth() pins).
 */
export async function verifyPayment(
    hash: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        const tx = await horizon.transactions().transaction(hash).call();
        if (!tx.successful) return { ok: false, reason: 'tx not successful' };
        if (tx.source_account !== config.nursePublic) {
            return {
                ok: false,
                reason: `tx source ${tx.source_account} != expected nurse ${config.nursePublic}`,
            };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
}
