/**
 * Stellar helpers (UI runtime).
 *
 * Kept intentionally small: JS only signs and submits a WASM-prepared Soroban tx.
 * All proving, witness building, and tx preparation lives in the Rust WASM layer.
 */

import { rpc, contract, ScInt } from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import { signWalletAuthEntry, signWalletTransaction } from './wallet.js';
import type { Proved, ProvedExtData, ProvedPrepared, ProveStatus } from './types.js';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function toBytes(value: unknown, what = 'bytes'): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    if (
        value &&
        typeof value === 'object' &&
        typeof (value as { length?: number }).length === 'number'
    ) {
        try {
            return new Uint8Array(Array.from(value as ArrayLike<number>));
        } catch {
            // fall through
        }
    }
    throw new Error(`Invalid ${what}`);
}

function parseU256HexToBigInt(hex: string, what: string): bigint {
    if (typeof hex !== 'string' || !hex.startsWith('0x')) {
        throw new Error(`Invalid ${what}`);
    }
    try {
        return BigInt(hex);
    } catch {
        throw new Error(`Invalid ${what}`);
    }
}

function toI256ScVal(value: string | number | bigint | undefined, what: string): xdr.ScVal {
    try {
        const bi = typeof value === 'bigint' ? value : BigInt(String(value));
        return new ScInt(bi, { type: 'i256' }).toScVal();
    } catch {
        throw new Error(`Invalid ${what}`);
    }
}

function getProvedFields(proved: Proved): {
    proofUncompressed: Uint8Array | number[] | undefined;
    extData: ProvedExtData | undefined;
    prepared: ProvedPrepared | undefined;
} {
    return {
        proofUncompressed: proved?.proofUncompressed ?? proved?.proof_uncompressed,
        extData: proved?.extData ?? proved?.ext_data,
        prepared: proved?.prepared,
    };
}

function getExtDataFields(extData: ProvedExtData | undefined) {
    return {
        recipient: extData?.recipient,
        extAmount: extData?.ext_amount ?? extData?.extAmount,
        encryptedOutput0: extData?.encrypted_output0 ?? extData?.encryptedOutput0,
        encryptedOutput1: extData?.encrypted_output1 ?? extData?.encryptedOutput1,
    };
}

export interface SorobanTxContext {
    address: string;
    rpcUrl: string;
    networkPassphrase: string;
}

export interface SubmitOpts {
    onStatus?: (p: ProveStatus) => void;
}

function makeEmit(
    onStatus: SubmitOpts['onStatus'],
): (stage: string, message: string, current?: number, total?: number) => void {
    return (stage, message, current, total) => {
        if (!onStatus) return;
        try {
            const p: ProveStatus = { stage, message };
            if (typeof current === 'number') p.current = current;
            if (typeof total === 'number') p.total = total;
            onStatus(p);
        } catch {
            // best-effort
        }
    };
}

export interface PoolTransactContext extends SorobanTxContext {
    poolContractId: string;
}

/**
 * Build, simulate, sign, and submit a pool `transact` transaction using the JS Stellar SDK.
 */
export async function submitProvedPoolTransact(
    proved: Proved,
    ctx: PoolTransactContext,
    opts: SubmitOpts = {},
): Promise<string> {
    const { address, rpcUrl, networkPassphrase, poolContractId } =
        ctx || ({} as PoolTransactContext);
    const emit = makeEmit(opts.onStatus);

    if (!address) throw new Error('Missing address');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!networkPassphrase) throw new Error('Missing networkPassphrase');
    if (!poolContractId) throw new Error('Missing poolContractId');

    const { proofUncompressed, extData, prepared } = getProvedFields(proved);
    const proofBytes = toBytes(proofUncompressed, 'proofUncompressed');
    if (proofBytes.length !== 256) {
        throw new Error(`Invalid proofUncompressed (expected 256 bytes, got ${proofBytes.length})`);
    }

    const ext = getExtDataFields(extData);
    if (typeof ext.recipient !== 'string' || !ext.recipient)
        throw new Error('Invalid extData.recipient');
    const encrypted0 = toBytes(ext.encryptedOutput0, 'extData.encrypted_output0');
    const encrypted1 = toBytes(ext.encryptedOutput1, 'extData.encrypted_output1');

    if (!prepared) throw new Error('Invalid prepared');
    if (!prepared.poolRoot) throw new Error('Invalid prepared.poolRoot');
    if (!Array.isArray(prepared.inputNullifiers) || prepared.inputNullifiers.length !== 2) {
        throw new Error('Invalid prepared.inputNullifiers');
    }
    if (!Array.isArray(prepared.outputCommitments) || prepared.outputCommitments.length !== 2) {
        throw new Error('Invalid prepared.outputCommitments');
    }

    const extDataHash = toBytes(prepared.extDataHashBe, 'prepared.extDataHashBe');
    if (extDataHash.length !== 32) {
        throw new Error(
            `Invalid prepared.extDataHashBe (expected 32 bytes, got ${extDataHash.length})`,
        );
    }

    const contractProof = {
        proof: {
            a: proofBytes.slice(0, 64),
            b: proofBytes.slice(64, 192),
            c: proofBytes.slice(192, 256),
        },
        root: parseU256HexToBigInt(prepared.poolRoot, 'prepared.poolRoot'),
        input_nullifiers: [
            parseU256HexToBigInt(prepared.inputNullifiers[0], 'prepared.inputNullifiers[0]'),
            parseU256HexToBigInt(prepared.inputNullifiers[1], 'prepared.inputNullifiers[1]'),
        ],
        output_commitment0: parseU256HexToBigInt(
            prepared.outputCommitments[0],
            'prepared.outputCommitments[0]',
        ),
        output_commitment1: parseU256HexToBigInt(
            prepared.outputCommitments[1],
            'prepared.outputCommitments[1]',
        ),
        public_amount: parseU256HexToBigInt(prepared.publicAmount, 'prepared.publicAmount'),
        ext_data_hash: extDataHash,
        asp_membership_root: parseU256HexToBigInt(
            prepared.aspMembershipRoot,
            'prepared.aspMembershipRoot',
        ),
        asp_non_membership_root: parseU256HexToBigInt(
            prepared.aspNonMembershipRoot,
            'prepared.aspNonMembershipRoot',
        ),
    };

    const contractExtData = {
        encrypted_output0: encrypted0,
        encrypted_output1: encrypted1,
        ext_amount: toI256ScVal(ext.extAmount, 'extData.ext_amount'),
        recipient: ext.recipient,
    };

    emit('build_tx', 'Simulating & building…');
    const client = await contract.Client.from({
        rpcUrl,
        networkPassphrase,
        publicKey: address,
        contractId: poolContractId,
        signTransaction: (async (transactionXdr: string, extra: Record<string, unknown> = {}) => {
            emit('sign_tx', 'Approve transaction…');
            return signWalletTransaction(transactionXdr, { address, networkPassphrase, ...extra });
        }) as never,
        signAuthEntry: (async (entryXdr: string, extra: Record<string, unknown> = {}) => {
            emit('sign_auth', 'Approve authorization…');
            return signWalletAuthEntry(entryXdr, { address, networkPassphrase, ...extra });
        }) as never,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (client as any).transact({
        proof: contractProof,
        ext_data: contractExtData,
        sender: address,
    });

    emit('submit', 'Submitting…');
    const sent = await tx.signAndSend();
    const hash: string | null =
        sent?.sendTransactionResponse?.hash || sent?.hash || sent?.result?.hash || null;
    if (!hash) throw new Error('Transaction submission failed');

    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    for (let i = 0; i < 30; i++) {
        emit('confirm', 'Confirming…', i + 1, 30);
        await sleep(1_000);
        const res = await server.getTransaction(hash);
        if (res?.status === 'SUCCESS') return hash;
        if (res?.status === 'FAILED') {
            const xdrStr = res.resultXdr?.toXDR('base64');
            const err = xdrStr ? ` (resultXdr: ${xdrStr})` : '';
            throw new Error(`Transaction failed${err}`);
        }
    }

    return hash;
}
