import { z } from 'zod';
import { askNurse, fetchChallenge, type PatientConfig } from './consult-client.js';
import { ensureSidecar } from './sidecar.js';

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema?: z.ZodRawShape;
    handler: (args: Record<string, unknown>, config: PatientConfig) => Promise<unknown>;
}

export const tools: ToolDefinition[] = [
    {
        name: 'ask-nurse',
        description:
            'Ask the AI Nurse agent for general health guidance over a private channel. ' +
            'Each consult is paid for via the privacy-pool payment flow. The prover ' +
            'sidecar that settles the payment is started and funded automatically on the ' +
            "first consult (no manual bootstrap/start needed). Returns the nurse's reply " +
            'as plain text.',
        inputSchema: {
            question: z.string().min(1).describe('The health question to send to the nurse'),
        },
        handler: async (args, config) => {
            const question = args.question as string;
            // Bring the prover sidecar up (and fund it) if it isn't already — memoized.
            await ensureSidecar();
            const advice = await askNurse(config, question);
            return { advice };
        },
    },
    {
        name: 'get-challenge',
        description:
            "Fetch the AI Nurse's 402 payment challenge without paying. Useful for " +
            'previewing the cost (amountStroops), the pool contract, ASP contracts, ' +
            'and the nurse pubkeys before deciding to consult.',
        inputSchema: undefined,
        handler: async (_args, config) => {
            const challenge = await fetchChallenge(config);
            return { challenge };
        },
    },
];

export function getToolByName(name: string): ToolDefinition | undefined {
    return tools.find((t) => t.name === name);
}
