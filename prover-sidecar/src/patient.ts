/**
 * Patient-agent orchestration: the building blocks for autonomous pool
 * participation, driving the headless WASM (ProverBrowser) for proving and the
 * Node submit module for signing/submission.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { ProverBrowser } from './browser.js';
import { insertAspLeaf, submitPoolTransact, type SubmitCtx } from './submit.js';

export interface PatientConfig extends SubmitCtx {
    address: string;
    network: 'testnet' | 'pubnet';
    blinding: bigint;
}

export interface NurseChallenge {
    amountStroops: string;
    pool: string;
    nurseNotePubkey: string;
    nurseEncPubkey: string;
}

export function buildPatientConfig(env: NodeJS.ProcessEnv): PatientConfig {
    const secret = env.PATIENT_STELLAR_SECRET;
    if (!secret) throw new Error('PATIENT_STELLAR_SECRET is required');
    let address: string;
    try {
        address = Keypair.fromSecret(secret).publicKey();
    } catch {
        throw new Error('PATIENT_STELLAR_SECRET is not a valid Stellar secret (S…)');
    }
    const network = (env.STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'pubnet';
    if (network !== 'testnet' && network !== 'pubnet') {
        throw new Error(`STELLAR_NETWORK must be testnet or pubnet, got ${network}`);
    }
    const rpcUrl =
        env.STELLAR_RPC_URL ??
        (network === 'testnet'
            ? 'https://soroban-testnet.stellar.org'
            : 'https://soroban.stellar.org');
    const networkPassphrase = network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
    const blinding = BigInt(env.PATIENT_ASP_BLINDING ?? '0');
    return { secret, address, network, rpcUrl, networkPassphrase, blinding };
}

function normalizePubkeyHex(raw: string): string {
    let hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    try {
        hex = BigInt(raw).toString(16);
    } catch {
        // already bare hex
    }
    return '0x' + hex.padStart(64, '0');
}

function signMessageB64(kp: Keypair, message: string): string {
    const bytes = Buffer.from(new TextEncoder().encode(message));
    return kp.sign(bytes).toString('base64');
}

/** Sign the two derivation messages locally and persist the derived keys in the page's OPFS. */
export async function ensureKeysDerived(browser: ProverBrowser, cfg: PatientConfig): Promise<void> {
    const existing = await browser.getUserKeys(cfg.address);
    if (existing?.noteKeypair?.public && existing?.encryptionKeypair?.public) return;

    const kp = Keypair.fromSecret(cfg.secret);
    const msgs = await browser.keyMessages();
    const spendingSig = signMessageB64(kp, msgs.spending);
    const encryptionSig = signMessageB64(kp, msgs.encryption);
    await browser.deriveKeys(cfg.address, spendingSig, encryptionSig);
}

export async function registerAsp(browser: ProverBrowser, cfg: PatientConfig): Promise<string> {
    const cfgChain = await browser.getUserKeys(cfg.address);
    if (!cfgChain?.noteKeypair?.public) throw new Error('derive keys before registering ASP');
    const pubkeyHex = normalizePubkeyHex(cfgChain.noteKeypair.public);
    const leafHex = await browser.deriveAspLeaf(cfg.blinding, pubkeyHex);
    const contractConfig = await browser.contractConfig();
    return insertAspLeaf(cfg, contractConfig.asp_membership, BigInt(leafHex));
}

export async function deposit(
    browser: ProverBrowser,
    cfg: PatientConfig,
    amountStroops: bigint,
): Promise<string> {
    const proved = await browser.proveDeposit(cfg.address, cfg.blinding, amountStroops, [
        amountStroops,
        0n,
    ]);
    if (!proved) {
        throw new Error(
            'proveDeposit returned null — patient likely not registered in ASP membership for this blinding.',
        );
    }
    const contractConfig = await browser.contractConfig();
    return submitPoolTransact(proved, cfg, contractConfig.pool);
}

/**
 * Settle a nurse consult challenge: pick unspent notes, prove an in-pool
 * transfer (ext_amount=0, output0 → nurse, output1 → patient change), submit.
 * Returns the settlement tx hash.
 */
export async function settle(
    browser: ProverBrowser,
    cfg: PatientConfig,
    challenge: NurseChallenge,
): Promise<string> {
    const need = BigInt(challenge.amountStroops);

    const notes = await browser.getUserNotes(cfg.address, 50);
    const picked: { id: string; amount: string }[] = [];
    let sum = 0n;
    for (const n of notes) {
        if (n.spent) continue;
        if (sum >= need) break;
        if (picked.length >= 2) break;
        picked.push(n);
        sum += BigInt(n.amount);
    }
    if (sum < need) {
        throw new Error(`Insufficient unspent notes: have ${sum} stroops, need ${need}.`);
    }
    const change = sum - need;

    const keys = await browser.getUserKeys(cfg.address);
    if (!keys?.noteKeypair?.public || !keys?.encryptionKeypair?.public) {
        throw new Error('patient privacy keys missing');
    }
    const patientNotePub = normalizePubkeyHex(keys.noteKeypair.public);
    const patientEncPub = normalizePubkeyHex(keys.encryptionKeypair.public);

    const proved = await browser.proveTransact({
        address: cfg.address,
        blinding: cfg.blinding,
        extRecipient: challenge.pool,
        extAmount: 0n,
        inputNoteIds: picked.map((n) => n.id),
        outputs: [need, change],
        outNoteKeysHex: [challenge.nurseNotePubkey, patientNotePub],
        outEncKeysHex: [challenge.nurseEncPubkey, patientEncPub],
    });
    if (!proved) {
        throw new Error('proveTransact returned null (ASP registration or blinding mismatch?)');
    }
    return submitPoolTransact(proved, cfg, challenge.pool);
}
