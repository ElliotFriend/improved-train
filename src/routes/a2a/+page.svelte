<script lang="ts">
    import Markdown from '@humanspeak/svelte-markdown';

    type StepKind = 'request' | 'challenge' | 'protocol' | 'settled' | 'verify' | 'data' | 'error';

    interface FlowStep {
        kind: StepKind;
        label: string;
        detail?: string;
        link?: { href: string; text: string };
    }

    interface Challenge {
        scheme: string;
        recipient: string;
        asset: string;
        amount: string;
        network: string;
        contractId: string | null;
        groth16VerifierId: string | null;
        description: string;
    }

    let question = $state(
        "I've had a dull headache and mild dizziness on and off for three days. No fever. Should I worry?",
    );
    let flowSteps: FlowStep[] = $state([]);
    let advice = $state('');
    let isLoading = $state(false);

    const stepStyles: Record<StepKind, string> = {
        request: 'bg-gray-100 text-gray-700',
        challenge: 'bg-amber-100 text-amber-700',
        protocol: 'bg-indigo-100 text-indigo-700',
        settled: 'bg-purple-100 text-purple-700',
        verify: 'bg-purple-100 text-purple-700',
        data: 'bg-green-100 text-green-700',
        error: 'bg-red-100 text-red-700',
    };

    function pushStep(step: FlowStep) {
        flowSteps.push(step);
    }

    async function askNurse() {
        if (!question.trim() || isLoading) return;
        flowSteps = [];
        advice = '';
        isLoading = true;

        try {
            pushStep({ kind: 'request', label: 'POST /api/a2a/consult', detail: 'no payment' });
            const initial = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question }),
            });

            if (initial.status !== 402) {
                const body = await initial.text();
                pushStep({ kind: 'error', label: `Unexpected ${initial.status}`, detail: body });
                return;
            }

            const { challenge }: { challenge: Challenge } = await initial.json();
            const poolNote = challenge.contractId
                ? `pool ${challenge.contractId.slice(0, 6)}...`
                : 'pool not initialized';
            pushStep({
                kind: 'challenge',
                label: `402 Payment Required (${challenge.scheme})`,
                detail: `${challenge.amount} XLM to ${challenge.recipient.slice(0, 6)}...${challenge.recipient.slice(-4)} via ${poolNote}`,
                link: challenge.contractId
                    ? {
                          href: `https://stellar.expert/explorer/testnet/contract/${challenge.contractId}`,
                          text: 'View privacy-pool contract',
                      }
                    : undefined,
            });

            pushStep({ kind: 'protocol', label: 'Patient agent begins payment protocol' });

            const payRes = await fetch('/api/a2a/pay', { method: 'POST' });
            if (!payRes.body) throw new Error('no stream body');

            let settlementHash: string | undefined;
            const reader = payRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line) continue;
                    const event = JSON.parse(line) as
                        | { kind: 'step'; label: string; detail?: string }
                        | { kind: 'settled'; hash: string; ledger: number; explorer: string }
                        | { kind: 'error'; message: string };

                    if (event.kind === 'step') {
                        pushStep({ kind: 'protocol', label: event.label, detail: event.detail });
                    } else if (event.kind === 'settled') {
                        settlementHash = event.hash;
                        pushStep({
                            kind: 'settled',
                            label: 'Settlement confirmed on ledger',
                            detail: `ledger ${event.ledger}  ·  tx ${event.hash.slice(0, 10)}...`,
                            link: { href: event.explorer, text: 'View on Stellar Expert' },
                        });
                    } else if (event.kind === 'error') {
                        pushStep({ kind: 'error', label: 'Payment failed', detail: event.message });
                        return;
                    }
                }
            }

            if (!settlementHash) {
                pushStep({ kind: 'error', label: 'No settlement hash returned' });
                return;
            }

            pushStep({
                kind: 'verify',
                label: 'Re-requesting consult with payment receipt',
                detail: `X-Payment-Tx: ${settlementHash.slice(0, 12)}...`,
            });

            const final = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-payment-tx': settlementHash },
                body: JSON.stringify({ question }),
            });

            if (!final.ok) {
                const body = await final.text();
                pushStep({ kind: 'error', label: `Consult failed (${final.status})`, detail: body });
                return;
            }

            const { advice: nurseAdvice } = (await final.json()) as { advice: string };
            advice = nurseAdvice;
            pushStep({
                kind: 'data',
                label: 'Nurse agent response received',
                detail: `${nurseAdvice.length} chars`,
            });
        } catch (err) {
            pushStep({
                kind: 'error',
                label: 'Request failed',
                detail: err instanceof Error ? err.message : String(err),
            });
        } finally {
            isLoading = false;
        }
    }
</script>

<div class="space-y-8">
    <div>
        <div class="text-sm font-medium text-purple-600">Agent-to-Agent</div>
        <h1 class="text-2xl font-bold tracking-tight">Private Medical Consult</h1>
        <p class="mt-1 text-sm text-gray-500">
            The patient agent asks the nurse a question. The nurse replies HTTP 402 naming a
            privacy-pool contract and a recipient. The patient agent generates a Groth16 ZK
            proof and withdraws 1 XLM from the pool to the nurse. The nurse verifies the
            settlement on Horizon and replies. Real on-chain proof, real on-chain withdraw, real
            unlinkability.
        </p>
    </div>

    <div class="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
        One-shot per setup run: a privacy-pool insert exceeds Soroban's budget on the second
        deposit (see CAP-75), so each pool is single-use today. Re-run
        <code>scripts/a2a-setup.sh</code> between demos to deploy a fresh pool with a fresh
        deposited coin.
    </div>

    <div>
        <label for="q" class="block text-sm font-medium text-gray-700">
            Ask the nurse agent
        </label>
        <textarea
            id="q"
            bind:value={question}
            rows="3"
            class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
        ></textarea>
        <div class="mt-3 flex justify-end">
            <button
                onclick={askNurse}
                disabled={isLoading || !question.trim()}
                class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {isLoading ? 'Consulting...' : 'Ask Nurse Agent'}
            </button>
        </div>
    </div>

    {#if flowSteps.length > 0}
        <div class="rounded-lg border border-gray-200 bg-white p-5">
            <h2 class="mb-4 text-sm font-semibold text-gray-700">Protocol Flow</h2>
            <ol class="space-y-3">
                {#each flowSteps as step, i (`a2a-${i}`)}
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold {stepStyles[
                                step.kind
                            ]}"
                        >
                            {i + 1}
                        </span>
                        <div class="min-w-0">
                            <div class="text-sm font-medium text-gray-900">{step.label}</div>
                            {#if step.detail}
                                <div class="text-xs break-all text-gray-500">{step.detail}</div>
                            {/if}
                            {#if step.link}
                                <a
                                    href={step.link.href}
                                    target="_blank"
                                    rel="external noopener noreferrer"
                                    class="mt-0.5 inline-block text-xs font-medium text-indigo-600 underline"
                                >
                                    {step.link.text} &rarr;
                                </a>
                            {/if}
                        </div>
                    </li>
                {/each}
                {#if isLoading}
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100"
                        >
                            <span
                                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"
                            ></span>
                        </span>
                        <span class="text-sm text-gray-500">Working...</span>
                    </li>
                {/if}
            </ol>
        </div>
    {/if}

    {#if advice}
        <div class="rounded-lg border border-green-200 bg-green-50 p-5">
            <h2 class="mb-3 text-sm font-semibold text-green-800">Nurse Agent Response</h2>
            <div class="prose prose-sm max-w-none text-gray-900">
                <Markdown source={advice} />
            </div>
        </div>
    {/if}
</div>
