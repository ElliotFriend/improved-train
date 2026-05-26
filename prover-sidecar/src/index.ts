/**
 * Prover sidecar HTTP server.
 *
 * Holds the patient's Stellar secret, keeps a warm headless-Chromium WASM
 * client, and exposes:
 *
 *   GET  /health   → { ok, address, notes, unspentStroops }
 *   POST /prove     { challenge } → { txHash }
 *
 * The MCP server's settleChallenge POSTs a nurse challenge here; we pick notes,
 * prove the in-pool transfer, submit it with local-key signing, and return the
 * settlement hash. /prove calls are serialized (the WASM storage worker is
 * single-tab / single-writer).
 */
import { createServer } from 'node:http';
import { ProverBrowser } from './browser.js';
import {
    buildPatientConfig,
    ensureKeysDerived,
    settle,
    type NurseChallenge,
    type PatientConfig,
} from './patient.js';

const PORT = Number(process.env.PROVER_SIDECAR_PORT ?? '7878');

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function isChallenge(v: unknown): v is NurseChallenge {
    if (!v || typeof v !== 'object') return false;
    const c = v as Record<string, unknown>;
    return (
        typeof c.amountStroops === 'string' &&
        typeof c.pool === 'string' &&
        typeof c.nurseNotePubkey === 'string' &&
        typeof c.nurseEncPubkey === 'string'
    );
}

async function main() {
    const cfg: PatientConfig = buildPatientConfig(process.env);
    const browser = new ProverBrowser(cfg.rpcUrl);

    console.error(`[sidecar] patient ${cfg.address} — launching headless WASM…`);
    await browser.start();
    await ensureKeysDerived(browser, cfg);
    console.error('[sidecar] WASM warm, keys derived.');

    // Serialize prove operations (single-writer storage worker).
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => undefined);
        return run as Promise<T>;
    };

    const server = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            const json = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(json);
        };
        try {
            if (req.method === 'GET' && req.url === '/health') {
                const notes = await browser.getUserNotes(cfg.address, 50);
                const unspent = notes.filter((n) => !n.spent);
                send(200, {
                    ok: true,
                    address: cfg.address,
                    notes: notes.length,
                    unspentStroops: unspent
                        .reduce((a, n) => a + BigInt(n.amount), 0n)
                        .toString(),
                });
                return;
            }
            if (req.method === 'POST' && req.url === '/prove') {
                const body = (await readJson(req)) as { challenge?: unknown };
                if (!isChallenge(body.challenge)) {
                    send(400, { error: 'body.challenge missing required fields' });
                    return;
                }
                const challenge = body.challenge;
                console.error(`[sidecar] /prove: settling ${challenge.amountStroops} stroops…`);
                const txHash = await serialize(() => settle(browser, cfg, challenge));
                console.error(`[sidecar] /prove: settled ${txHash}`);
                send(200, { txHash });
                return;
            }
            send(404, { error: 'not found' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[sidecar] error: ${message}`);
            send(500, { error: message });
        }
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.error(`[sidecar] listening on http://127.0.0.1:${PORT}`);
    });

    const shutdown = async () => {
        console.error('[sidecar] shutting down…');
        server.close();
        await browser.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[sidecar] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
