import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from '$env/static/private';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MAX_MESSAGES = 20;
const MAX_BODY_BYTES = 32_768; // 32 KB

const emptySchema = {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
};

const tools: Anthropic.Tool[] = [
    {
        name: 'get_random_quote',
        description: 'Get a single random quote. Free — no payment required.',
        input_schema: emptySchema,
    },
    {
        name: 'get_random_recipe',
        description: 'Get a single random recipe. Free — no payment required.',
        input_schema: emptySchema,
    },
    {
        name: 'get_random_post',
        description: 'Get a single random post. Free — no payment required.',
        input_schema: emptySchema,
    },
    {
        name: 'get_all_quotes',
        description:
            'Get all available quotes. This is a PAID resource — costs 0.025 USDC via Stellar.',
        input_schema: emptySchema,
    },
    {
        name: 'get_all_recipes',
        description:
            'Get all available recipes. This is a PAID resource — costs 0.025 USDC via Stellar.',
        input_schema: emptySchema,
    },
    {
        name: 'get_all_posts',
        description:
            'Get all available posts. This is a PAID resource — costs 0.025 USDC via Stellar.',
        input_schema: emptySchema,
    },
];

const systemPrompt = `You are a helpful assistant embedded in a demo application for the Machine Payments Protocol (MPP). You have access to tools that fetch data from APIs — some are free, some cost 0.025 USDC each via the Stellar network.

When a user asks for data, use the appropriate tool. If a free tool can satisfy the request, prefer it. If the user asks for "all" of something or needs comprehensive data, use the paid tool and let them know it will cost 0.025 USDC.

The payment happens automatically — you don't need to handle it. Just call the tool and the user's browser will handle the Stellar transaction.

Keep responses concise and helpful.`;

export const POST: RequestHandler = async ({ request, url }) => {
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) {
        error(403, { message: 'Forbidden: requests must originate from the same domain' });
    }

    const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
        error(413, { message: `Request body too large (max ${MAX_BODY_BYTES} bytes)` });
    }

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
        error(413, { message: `Request body too large (max ${MAX_BODY_BYTES} bytes)` });
    }

    const { messages }: { messages: Anthropic.MessageParam[] } = JSON.parse(body);

    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
        error(400, { message: `messages must be an array of 1-${MAX_MESSAGES} items` });
    }

    // debugging
    console.log('latest message', messages[messages.length - 1]);

    const stream = client.messages.stream({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
        async start(controller) {
            try {
                for await (const event of stream) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                }
                const finalMessage = await stream.finalMessage();
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: 'final_message', message: finalMessage })}\n\n`,
                    ),
                );
            } catch (err) {
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : String(err) })}\n\n`,
                    ),
                );
            } finally {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        },
    });

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        },
    });
};
