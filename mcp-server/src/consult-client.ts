/**
 * Patient-agent side of the AI Nurse consult flow.
 *
 * Mirrors `paidFetch` in stellar-observatory's mcp-server/src/x402-client.ts,
 * but adapted for the AI Nurse's privacy-pool challenge instead of x402.
 *
 *   1. POST /api/a2a/consult { question }  → 402 with `challenge` JSON
 *   2. settle the challenge by submitting a pool `transact()` tx, get hash
 *   3. POST /api/a2a/consult { question } with `x-payment-tx: <hash>`
 *      header → 200 with { advice }
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';

export interface PatientConfig {
    secretKey: string;
    baseUrl: string;
    network: 'testnet' | 'pubnet';
    rpcUrl: string;
    networkPassphrase: string;
}

export interface NurseChallenge {
    scheme: string;
    network: string;
    recipient: string;
    asset: string;
    amountStroops: string;
    pool: string;
    aspMembership: string;
    aspNonMembership: string;
    nurseNotePubkey: string;
    nurseEncPubkey: string;
    description?: string;
}

interface ChallengeResponse {
    error: string;
    challenge: NurseChallenge;
}

interface AdviceResponse {
    advice: string;
    paymentTx: string;
}

export function buildPatientConfig(env: NodeJS.ProcessEnv): PatientConfig {
    const secretKey = env.PATIENT_STELLAR_SECRET;
    if (!secretKey) throw new Error('PATIENT_STELLAR_SECRET is required');
    try {
        Keypair.fromSecret(secretKey);
    } catch {
        throw new Error('PATIENT_STELLAR_SECRET is not a valid Stellar secret (S…)');
    }

    const baseUrl = (env.MPP_DEMO_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    const network = (env.STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'pubnet';
    if (network !== 'testnet' && network !== 'pubnet') {
        throw new Error(`STELLAR_NETWORK must be testnet or pubnet, got ${network}`);
    }
    const defaultRpc =
        network === 'testnet'
            ? 'https://soroban-testnet.stellar.org'
            : 'https://soroban.stellar.org';
    const rpcUrl = env.STELLAR_RPC_URL ?? defaultRpc;
    const networkPassphrase = network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

    return { secretKey, baseUrl, network, rpcUrl, networkPassphrase };
}

/**
 * Fetch the 402 challenge without paying. Useful for an agent that wants to
 * see the cost before deciding to consult.
 */
export async function fetchChallenge(
    config: PatientConfig,
    question = 'preview',
): Promise<NurseChallenge> {
    const res = await fetch(`${config.baseUrl}/api/a2a/consult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
    });
    if (res.status === 200) {
        throw new Error(
            'Nurse did not issue a 402 challenge — server may be misconfigured (try a different question or check ANTHROPIC_API_KEY / payment env on the SvelteKit app).',
        );
    }
    if (res.status !== 402) {
        throw new Error(`Expected 402, got ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as ChallengeResponse;
    if (!body?.challenge) throw new Error('402 response has no challenge field');
    return body.challenge;
}

/**
 * Full ask-nurse flow: challenge → settle → ask. Returns the nurse's advice.
 */
export async function askNurse(config: PatientConfig, question: string): Promise<string> {
    const challengeRes = await fetch(`${config.baseUrl}/api/a2a/consult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
    });

    if (challengeRes.status !== 402) {
        throw new Error(
            `expected 402 from initial consult, got ${challengeRes.status}: ${await challengeRes.text()}`,
        );
    }
    const challengeBody = (await challengeRes.json()) as ChallengeResponse;
    const challenge = challengeBody?.challenge;
    if (!challenge) throw new Error('402 response has no challenge field');

    const paymentTx = await settleChallenge(config, challenge);

    const paidRes = await fetch(`${config.baseUrl}/api/a2a/consult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment-tx': paymentTx },
        body: JSON.stringify({ question }),
    });
    if (!paidRes.ok) {
        throw new Error(
            `paid consult failed: ${paidRes.status}: ${await paidRes.text()}`,
        );
    }
    const body = (await paidRes.json()) as AdviceResponse;
    if (!body?.advice) throw new Error('paid consult succeeded but reply has no advice field');
    return body.advice;
}

/**
 * Settle the nurse's payment challenge by submitting a privacy-pool
 * `proveTransact` tx and returning the resulting tx hash.
 *
 * TODO: this is the proving step that needs a prover backend. Options:
 *
 *   1. Node-targeted WASM build of the upstream Nethermind prover (durable).
 *      Sibling crate to `stellar-private-payments/app/crates/platforms/web`,
 *      swap gloo-worker → worker_threads, OPFS → better-sqlite3.
 *
 *   2. Headless-Chrome sidecar: a small SvelteKit/Express service that hosts
 *      the existing browser WASM and exposes POST /prove → { paymentTxHash }.
 *      Spin it up alongside this MCP. Patient secret stays here; the sidecar
 *      only needs the proving keys + the nurse pubkeys from the challenge.
 *
 *   3. Cheat: pre-fund pool notes out of band and submit non-private XLM
 *      payments here. Loses the privacy property the demo is built around;
 *      only useful as a last-resort fallback for showing the agent-loop.
 *
 * For now this throws so the agent surface fails loudly and the calling LLM
 * can report the gap accurately.
 */
async function settleChallenge(
    _config: PatientConfig,
    _challenge: NurseChallenge,
): Promise<string> {
    void _config;
    void _challenge;
    throw new Error(
        'settleChallenge is not yet implemented: the privacy-pool proveTransact ' +
            'prover is browser-only WASM. See README + JSDoc on settleChallenge for ' +
            'the three backend options (Node-WASM port, headless-Chrome sidecar, ' +
            'or non-private payment fallback).',
    );
}
