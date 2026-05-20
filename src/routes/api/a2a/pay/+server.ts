import type { RequestHandler } from './$types';
import { coinAvailable, submitPrivacyPoolWithdraw } from '$lib/a2a/server';

export const POST: RequestHandler = async () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (obj: unknown) =>
                controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

            try {
                if (!coinAvailable()) {
                    send({
                        kind: 'error',
                        message:
                            'No spendable coin in .a2a/ -- run scripts/a2a-setup.sh first ' +
                            '(privacy-pool deposits are 1-shot today; re-run between demos).',
                    });
                    return;
                }

                const { hash, ledger } = await submitPrivacyPoolWithdraw({
                    step: (label, detail) => send({ kind: 'step', label, detail }),
                });

                send({
                    kind: 'settled',
                    hash,
                    ledger,
                    explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
                });
            } catch (err) {
                send({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
};
