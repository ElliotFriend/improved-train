/**
 * Node-side Soroban submission with local Keypair signing — the headless
 * equivalent of src/lib/spp/stellar.ts (which signs via Freighter).
 *
 * Two entry points:
 *   - submitPoolTransact: submit a proved deposit/transact to the pool
 *   - insertAspLeaf: register a leaf in the ASP membership contract
 *
 * Signing mirrors scripts/setup-nurse: tx.sign(keypair) for the envelope and
 * authorizeEntry(...) for Soroban auth entries.
 */
import {
    Keypair,
    ScInt,
    TransactionBuilder,
    authorizeEntry,
    contract,
    rpc,
    xdr,
} from '@stellar/stellar-sdk';

export interface SubmitCtx {
    secret: string;
    rpcUrl: string;
    networkPassphrase: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function toBytes(value: unknown, what: string): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value as number[]);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error(`Invalid ${what}`);
}

function parseU256Hex(hex: unknown, what: string): bigint {
    if (typeof hex !== 'string' || !hex.startsWith('0x')) throw new Error(`Invalid ${what}`);
    try {
        return BigInt(hex);
    } catch {
        throw new Error(`Invalid ${what}`);
    }
}

function toI256ScVal(value: unknown, what: string): xdr.ScVal {
    try {
        const bi = typeof value === 'bigint' ? value : BigInt(String(value));
        return new ScInt(bi, { type: 'i256' }).toScVal();
    } catch {
        throw new Error(`Invalid ${what}`);
    }
}

/** Build the contract.Client signing callbacks for a local Keypair. */
function localSigners(keypair: Keypair, ctx: SubmitCtx) {
    const server = new rpc.Server(ctx.rpcUrl, { allowHttp: ctx.rpcUrl.startsWith('http://') });
    return {
        signTransaction: (async (xdrStr: string) => {
            const tx = TransactionBuilder.fromXDR(xdrStr, ctx.networkPassphrase);
            tx.sign(keypair);
            return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
        }) as never,
        signAuthEntry: (async (entryXdr: string) => {
            const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
            const { sequence } = await server.getLatestLedger();
            const signed = await authorizeEntry(
                entry,
                keypair,
                sequence + 1000,
                ctx.networkPassphrase,
            );
            return {
                signedAuthEntry: signed.toXDR('base64'),
                signerAddress: keypair.publicKey(),
            };
        }) as never,
    };
}

async function confirm(server: rpc.Server, hash: string): Promise<string> {
    for (let i = 0; i < 30; i++) {
        await sleep(1_000);
        const res = await server.getTransaction(hash);
        if (res?.status === 'SUCCESS') return hash;
        if (res?.status === 'FAILED') {
            const xdrStr = res.resultXdr?.toXDR('base64');
            throw new Error(`Transaction failed${xdrStr ? ` (resultXdr: ${xdrStr})` : ''}`);
        }
    }
    return hash;
}

export async function submitPoolTransact(
    proved: Record<string, unknown>,
    ctx: SubmitCtx,
    poolContractId: string,
): Promise<string> {
    const keypair = Keypair.fromSecret(ctx.secret);
    const address = keypair.publicKey();

    const proofUncompressed = proved.proofUncompressed ?? proved.proof_uncompressed;
    const extData = (proved.extData ?? proved.ext_data) as Record<string, unknown> | undefined;
    const prepared = proved.prepared as Record<string, unknown> | undefined;
    if (!extData) throw new Error('proved.extData missing');
    if (!prepared) throw new Error('proved.prepared missing');

    const proofBytes = toBytes(proofUncompressed, 'proofUncompressed');
    if (proofBytes.length !== 256) {
        throw new Error(`Invalid proofUncompressed (expected 256 bytes, got ${proofBytes.length})`);
    }

    const recipient = extData.recipient;
    if (typeof recipient !== 'string' || !recipient) throw new Error('Invalid extData.recipient');
    const enc0 = toBytes(extData.encrypted_output0 ?? extData.encryptedOutput0, 'encrypted_output0');
    const enc1 = toBytes(extData.encrypted_output1 ?? extData.encryptedOutput1, 'encrypted_output1');
    const extAmount = extData.ext_amount ?? extData.extAmount;

    const inputNullifiers = prepared.inputNullifiers as string[];
    const outputCommitments = prepared.outputCommitments as string[];
    const extDataHash = toBytes(prepared.extDataHashBe, 'extDataHashBe');
    if (extDataHash.length !== 32) throw new Error('Invalid prepared.extDataHashBe');

    const contractProof = {
        proof: {
            a: proofBytes.slice(0, 64),
            b: proofBytes.slice(64, 192),
            c: proofBytes.slice(192, 256),
        },
        root: parseU256Hex(prepared.poolRoot, 'poolRoot'),
        input_nullifiers: [
            parseU256Hex(inputNullifiers[0], 'inputNullifiers[0]'),
            parseU256Hex(inputNullifiers[1], 'inputNullifiers[1]'),
        ],
        output_commitment0: parseU256Hex(outputCommitments[0], 'outputCommitments[0]'),
        output_commitment1: parseU256Hex(outputCommitments[1], 'outputCommitments[1]'),
        public_amount: parseU256Hex(prepared.publicAmount, 'publicAmount'),
        ext_data_hash: extDataHash,
        asp_membership_root: parseU256Hex(prepared.aspMembershipRoot, 'aspMembershipRoot'),
        asp_non_membership_root: parseU256Hex(
            prepared.aspNonMembershipRoot,
            'aspNonMembershipRoot',
        ),
    };

    const contractExtData = {
        encrypted_output0: enc0,
        encrypted_output1: enc1,
        ext_amount: toI256ScVal(extAmount, 'ext_amount'),
        recipient,
    };

    const client = await contract.Client.from({
        rpcUrl: ctx.rpcUrl,
        networkPassphrase: ctx.networkPassphrase,
        publicKey: address,
        contractId: poolContractId,
        ...localSigners(keypair, ctx),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (client as any).transact({
        proof: contractProof,
        ext_data: contractExtData,
        sender: address,
    });
    const sent = await tx.signAndSend();
    const hash: string | null =
        sent?.sendTransactionResponse?.hash || sent?.hash || sent?.result?.hash || null;
    if (!hash) throw new Error('pool transact submission failed (no hash)');

    const server = new rpc.Server(ctx.rpcUrl, { allowHttp: ctx.rpcUrl.startsWith('http://') });
    return confirm(server, hash);
}

export async function insertAspLeaf(
    ctx: SubmitCtx,
    aspMembershipId: string,
    leaf: bigint,
): Promise<string> {
    const keypair = Keypair.fromSecret(ctx.secret);
    const client = await contract.Client.from({
        rpcUrl: ctx.rpcUrl,
        networkPassphrase: ctx.networkPassphrase,
        publicKey: keypair.publicKey(),
        contractId: aspMembershipId,
        ...localSigners(keypair, ctx),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (client as any).insert_leaf({ leaf });
    const sent = await tx.signAndSend();
    const hash: string | null =
        sent?.sendTransactionResponse?.hash || sent?.hash || sent?.result?.hash || null;
    if (!hash) throw new Error('insert_leaf submission failed (no hash)');

    const server = new rpc.Server(ctx.rpcUrl, { allowHttp: ctx.rpcUrl.startsWith('http://') });
    return confirm(server, hash);
}
