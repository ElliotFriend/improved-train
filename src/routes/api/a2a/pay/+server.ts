import type { RequestHandler } from './$types';
import { protocolSteps, submitPayment } from '$lib/a2a/server';

/**
 * NDJSON stream of the patient agent's payment protocol. Each line is one
 * step; the final line carries the settlement tx hash that the caller passes
 * back to the nurse endpoint via X-Payment-Tx.
 */
export const POST: RequestHandler = async () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (obj: unknown) =>
                controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

            try {
                for (const step of protocolSteps) {
                    send({ kind: 'step', label: step.label, detail: step.detail });
                    await new Promise((r) => setTimeout(r, step.durationMs));
                }

                send({ kind: 'step', label: 'Broadcasting transaction to Horizon' });
                const { hash, ledger } = await submitPayment();

                send({
                    kind: 'settled',
                    hash,
                    ledger,
                    explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
                });
            } catch (err) {
                send({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
};
