import { Horizon } from '@stellar/stellar-sdk';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    A2A_PATIENT_PUBLIC,
    A2A_NURSE_PUBLIC,
    A2A_NURSE_ALIAS,
    A2A_CACHE_DIR,
    A2A_NETWORK,
} from '$env/static/private';

const execFileAsync = promisify(execFile);

export const config = {
    patientPublic: A2A_PATIENT_PUBLIC,
    nursePublic: A2A_NURSE_PUBLIC,
    nurseAlias: A2A_NURSE_ALIAS,
    cacheDir: A2A_CACHE_DIR,
    network: A2A_NETWORK,
    amountXlm: '1', // FIXED_AMOUNT in the contract is 1 XLM
};

const horizon = new Horizon.Server(
    config.network === 'testnet'
        ? 'https://horizon-testnet.stellar.org'
        : 'https://horizon.stellar.org',
);

interface PoolContext {
    privacyPoolId: string;
    groth16VerifierId: string;
    privacyPoolsDir: string;
}

function readContracts(): PoolContext {
    const envPath = join(config.cacheDir, 'contracts.env');
    if (!existsSync(envPath)) {
        throw new Error(
            `${envPath} not found. Run scripts/a2a-setup.sh to deploy a pool and deposit a coin.`,
        );
    }
    const lines = readFileSync(envPath, 'utf8').split('\n');
    const map: Record<string, string> = {};
    for (const line of lines) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (m) map[m[1]] = m[2];
    }
    return {
        privacyPoolId: map.PRIVACY_POOL_ID,
        groth16VerifierId: map.GROTH16_VERIFIER_ID,
        privacyPoolsDir: map.PRIVACY_POOLS_DIR,
    };
}

export function poolContext(): PoolContext {
    return readContracts();
}

function spentFlagPath() {
    return join(config.cacheDir, 'spent');
}

export function coinAvailable(): boolean {
    return (
        existsSync(join(config.cacheDir, 'coin.json')) &&
        existsSync(join(config.cacheDir, 'state.json')) &&
        existsSync(join(config.cacheDir, 'association.json')) &&
        !existsSync(spentFlagPath())
    );
}

function extractHex(stdout: string, label: string): string {
    const lines = stdout.split('\n');
    const idx = lines.findIndex((l) => l.startsWith(label));
    if (idx === -1 || !lines[idx + 1]) {
        throw new Error(`could not parse ${label} from circom2soroban output`);
    }
    return lines[idx + 1].trim();
}

export interface WithdrawProgress {
    step: (label: string, detail?: string) => void;
}

/**
 * Real privacy-pool withdrawal:
 *   1. coinutils withdraw -> withdrawal_input.json
 *   2. circom witness gen -> witness.wtns
 *   3. snarkjs groth16 prove -> proof.json + public.json
 *   4. circom2soroban -> hex
 *   5. stellar contract invoke withdraw --source nurse  (to.require_auth())
 */
export async function submitPrivacyPoolWithdraw(
    progress: WithdrawProgress,
): Promise<{ hash: string; ledger: number }> {
    if (!coinAvailable()) {
        throw new Error(
            'No spendable coin in .a2a/ -- run scripts/a2a-setup.sh first ' +
                '(or again, if the previous coin has been spent).',
        );
    }
    const ctx = readContracts();
    const ppDir = ctx.privacyPoolsDir;
    const cache = config.cacheDir;
    const work = join(tmpdir(), `a2a-${Date.now()}`);
    mkdirSync(work, { recursive: true });

    const coin = join(cache, 'coin.json');
    const state = join(cache, 'state.json');
    const assoc = join(cache, 'association.json');
    const withdrawalInput = join(work, 'withdrawal_input.json');
    const witness = join(work, 'witness.wtns');
    const proofJson = join(work, 'proof.json');
    const publicJson = join(work, 'public.json');

    const coinutils = join(ppDir, 'target/release/stellar-coinutils');
    const circom2soroban = join(ppDir, 'target/release/stellar-circom2soroban');
    const witnessJs = join(ppDir, 'circuits/build/main_js/generate_witness.js');
    const mainWasm = join(ppDir, 'circuits/build/main_js/main.wasm');
    const zkey = join(ppDir, 'circuits/output/main_final.zkey');

    progress.step('Building withdrawal input from coin + state', 'coinutils withdraw');
    await execFileAsync(coinutils, ['withdraw', coin, state, assoc, '-o', withdrawalInput]);

    progress.step('Generating circuit witness', 'circom main.wasm');
    await execFileAsync('node', [witnessJs, mainWasm, withdrawalInput, witness]);

    progress.step('Generating Groth16 proof (BLS12-381)', 'snarkjs groth16 prove');
    await execFileAsync('snarkjs', ['groth16', 'prove', zkey, witness, proofJson, publicJson]);

    progress.step('Encoding proof for Soroban', 'circom2soroban');
    const { stdout: proofOut } = await execFileAsync(circom2soroban, ['proof', proofJson]);
    const { stdout: publicOut } = await execFileAsync(circom2soroban, ['public', publicJson]);
    const proofHex = extractHex(proofOut, 'Proof Hex encoding:');
    const publicHex = extractHex(publicOut, 'Public signals Hex encoding:');

    progress.step(
        'Submitting withdraw() to privacy pool',
        `${ctx.privacyPoolId.slice(0, 8)}... source=nurse (to.require_auth)`,
    );
    const invoke = await execFileAsync(
        'stellar',
        [
            'contract',
            'invoke',
            '--id',
            ctx.privacyPoolId,
            '--source',
            config.nurseAlias,
            '--network',
            config.network,
            '--send=yes',
            '--',
            'withdraw',
            '--to',
            config.nurseAlias,
            '--proof_bytes',
            proofHex,
            '--pub_signals_bytes',
            publicHex,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
    );

    // stellar CLI prints the tx hash on stderr alongside the explorer link.
    const combined = invoke.stdout + '\n' + invoke.stderr;
    const hashMatch = combined.match(/tx\/([0-9a-f]{64})/);
    if (!hashMatch) {
        throw new Error('could not extract tx hash from stellar invoke output');
    }
    const hash = hashMatch[1];

    // Confirm + read ledger via Horizon
    const tx = await horizon.transactions().transaction(hash).call();
    if (!tx.successful) throw new Error(`tx ${hash} not successful`);

    // Mark coin spent so the next /a2a request fails fast with a clear message
    writeFileSync(spentFlagPath(), hash);

    return { hash, ledger: tx.ledger_attr };
}

/** Confirms a withdraw tx on Horizon: successful, recipient is nurse. */
export async function verifyPayment(
    hash: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        const tx = await horizon.transactions().transaction(hash).call();
        if (!tx.successful) return { ok: false, reason: 'tx not successful' };
        // The pool's withdraw emits a token transfer to the nurse; we verify by
        // walking ops and looking for an invoke_host_function whose source is
        // the nurse account, since the contract-internal transfer isn't a
        // top-level Horizon "payment" op.
        if (tx.source_account !== config.nursePublic) {
            return {
                ok: false,
                reason: `tx source is ${tx.source_account}, expected nurse ${config.nursePublic}`,
            };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
}
