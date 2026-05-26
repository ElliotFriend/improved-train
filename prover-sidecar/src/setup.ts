/**
 * One-time patient setup CLI: derive privacy keys, register in ASP membership,
 * and deposit XLM into the pool so the patient has notes to spend on consults.
 *
 *   PATIENT_STELLAR_SECRET=S… PATIENT_DEPOSIT_XLM=50 pnpm --filter mpp-demo-prover-sidecar setup
 *
 * Idempotent-ish: re-deriving keys is a no-op; re-registering the same ASP leaf
 * will fail at the contract (caught + reported); depositing again just adds
 * more notes.
 */
import { ProverBrowser } from './browser.js';
import { buildPatientConfig, ensureKeysDerived, registerAsp, deposit } from './patient.js';

const DEPOSIT_XLM = process.env.PATIENT_DEPOSIT_XLM ?? '50';

function xlmToStroops(s: string): bigint {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error('PATIENT_DEPOSIT_XLM must be positive');
    return BigInt(Math.round(n * 1e7));
}

async function main() {
    const cfg = buildPatientConfig(process.env);
    console.error(`[setup] patient ${cfg.address}, network ${cfg.network}, blinding ${cfg.blinding}`);

    const browser = new ProverBrowser(cfg.rpcUrl);
    try {
        console.error('[setup] launching headless WASM…');
        await browser.start();

        console.error('[setup] deriving privacy keys…');
        await ensureKeysDerived(browser, cfg);
        const keys = await browser.getUserKeys(cfg.address);
        console.error(`[setup] note pubkey:  ${keys?.noteKeypair.public}`);
        console.error(`[setup] enc  pubkey:  ${keys?.encryptionKeypair.public}`);

        console.error('[setup] registering ASP membership leaf…');
        try {
            const aspHash = await registerAsp(browser, cfg);
            console.error(`[setup] ASP leaf registered: ${aspHash}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/already|exists|duplicate/i.test(msg)) {
                console.error('[setup] ASP leaf already present — continuing.');
            } else {
                throw err;
            }
        }

        const amount = xlmToStroops(DEPOSIT_XLM);
        console.error(`[setup] depositing ${DEPOSIT_XLM} XLM (${amount} stroops)…`);
        const depHash = await deposit(browser, cfg, amount);
        console.error(`[setup] deposit submitted: ${depHash}`);

        console.error('[setup] waiting for indexer to surface notes…');
        let notes = await browser.getUserNotes(cfg.address, 50);
        for (let i = 0; i < 20 && notes.filter((n) => !n.spent).length === 0; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            notes = await browser.getUserNotes(cfg.address, 50);
        }
        const unspent = notes.filter((n) => !n.spent);
        console.error(
            `[setup] notes: ${notes.length} total, ${unspent.length} unspent ` +
                `(${unspent.reduce((a, n) => a + BigInt(n.amount), 0n)} stroops)`,
        );
        console.error('[setup] DONE — patient is ready to consult.');
    } finally {
        await browser.stop();
    }
}

main().catch((err) => {
    console.error('[setup] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
