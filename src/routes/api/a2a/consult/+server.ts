import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from '$env/static/private';
import { config, poolContext, verifyPayment } from '$lib/a2a/server';

const hasAnthropicKey = !!ANTHROPIC_API_KEY;
const client = hasAnthropicKey ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const NURSE_SYSTEM = `You are an empathetic nurse agent providing general health guidance over a
private channel. The patient paid you through a privacy pool, so even their wallet address is
unlinkable to you. Reply in 3-6 short paragraphs:
1. Restate what you understand they're asking, in plain language.
2. Possible non-emergency explanations.
3. Self-care steps they can try.
4. Specific red-flag symptoms that should prompt an ER visit.
5. Whether to see a clinician in person and how urgently.
Avoid disclaimers like "I'm an AI"; you are the nurse for this purpose, but recommend they consult
a licensed clinician for diagnosis.`;

export const POST: RequestHandler = async ({ request }) => {
    const body = (await request.json()) as { question?: string };
    const question = (body.question ?? '').trim();
    if (!question) return json({ error: 'question required' }, { status: 400 });

    const paymentTx = request.headers.get('x-payment-tx');

    if (!paymentTx) {
        let ctx: ReturnType<typeof poolContext> | null = null;
        try {
            ctx = poolContext();
        } catch {
            // Setup hasn't been run yet; still return a 402 so the UI can show
            // a helpful next-step.
        }
        return json(
            {
                error: 'Payment Required',
                challenge: {
                    scheme: 'stellar-privacy-pool',
                    network: config.network,
                    recipient: config.nursePublic,
                    asset: 'native',
                    amount: config.amountXlm,
                    contractId: ctx?.privacyPoolId ?? null,
                    groth16VerifierId: ctx?.groth16VerifierId ?? null,
                    description: 'Private consultation with nurse agent',
                },
            },
            { status: 402 },
        );
    }

    const verdict = await verifyPayment(paymentTx);
    if (!verdict.ok) {
        return json({ error: `payment verification failed: ${verdict.reason}` }, { status: 402 });
    }

    if (!client) {
        return json({
            advice:
                '_(Nurse agent is unconfigured -- set `ANTHROPIC_API_KEY` in `.env` to generate a real reply.)_\n\n' +
                `Settlement verified on Horizon: \`${paymentTx}\` (privacy-pool withdraw, ` +
                `${config.amountXlm} XLM to nurse).`,
            paymentTx,
        });
    }

    const completion = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: NURSE_SYSTEM,
        messages: [{ role: 'user', content: question }],
    });

    const text = completion.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

    return json({ advice: text, paymentTx });
};
