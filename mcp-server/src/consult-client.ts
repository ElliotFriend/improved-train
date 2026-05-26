/**
 * Patient-agent side of the AI Nurse consult flow.
 *
 * Mirrors `paidFetch` in stellar-observatory's mcp-server/src/x402-client.ts,
 * but adapted for the AI Nurse's privacy-pool challenge instead of x402.
 *
 *   1. POST /api/a2a/consult { question }  → 402 with `challenge` JSON
 *   2. settle the challenge via the prover sidecar (POST /prove), get hash
 *   3. POST /api/a2a/consult { question } with `x-payment-tx: <hash>`
 *      header → 200 with { advice }
 *
 * The patient's Stellar secret + the privacy-pool prover live in the sidecar
 * (see ../../prover-sidecar). This client only orchestrates HTTP.
 */

export interface PatientConfig {
    baseUrl: string;
    sidecarUrl: string;
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
    const baseUrl = (env.MPP_DEMO_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    const sidecarUrl = (env.PROVER_SIDECAR_URL ?? 'http://127.0.0.1:7878').replace(/\/$/, '');
    return { baseUrl, sidecarUrl };
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
 * Settle the nurse's payment challenge by delegating to the prover sidecar
 * (headless-Chromium-hosted privacy-pool prover; see ../../prover-sidecar).
 * The sidecar picks the patient's notes, proves the in-pool transfer, submits
 * it with the patient's key, and returns the settlement tx hash.
 */
async function settleChallenge(
    config: PatientConfig,
    challenge: NurseChallenge,
): Promise<string> {
    let res: Response;
    try {
        res = await fetch(`${config.sidecarUrl}/prove`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge }),
        });
    } catch (err) {
        throw new Error(
            `prover sidecar unreachable at ${config.sidecarUrl} ` +
                `(${err instanceof Error ? err.message : err}). It should be auto-started by ` +
                'the MCP server; if you disabled that (PROVER_SIDECAR_AUTOSTART=0), start it ' +
                'with `pnpm --filter mpp-demo-prover-sidecar start`.',
            { cause: err },
        );
    }
    if (!res.ok) {
        throw new Error(`prover sidecar /prove failed: ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { txHash?: string; error?: string };
    if (!body?.txHash) {
        throw new Error(`prover sidecar returned no txHash: ${body?.error ?? 'unknown error'}`);
    }
    return body.txHash;
}
