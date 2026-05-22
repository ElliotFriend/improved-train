<script lang="ts">
    import type { FlowStep, FlowStepKind } from './flow';

    interface Props {
        steps: FlowStep[];
    }

    let { steps }: Props = $props();

    const stepStyles: Record<FlowStepKind, string> = {
        request: 'bg-gray-100 text-gray-700',
        challenge: 'bg-amber-100 text-amber-700',
        protocol: 'bg-indigo-100 text-indigo-700',
        sign: 'bg-blue-100 text-blue-700',
        submit: 'bg-cyan-100 text-cyan-700',
        settled: 'bg-purple-100 text-purple-700',
        verify: 'bg-purple-100 text-purple-700',
        data: 'bg-green-100 text-green-700',
        error: 'bg-red-100 text-red-700',
    };
</script>

{#if steps.length > 0}
    <div class="rounded-lg border border-gray-200 bg-white p-5">
        <h2 class="mb-4 text-sm font-semibold text-gray-700">Protocol Flow</h2>
        <ol class="space-y-3">
            {#each steps as step, i (i)}
                <li class="flex items-start gap-3">
                    {#if step.pending}
                        <span
                            class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100"
                        >
                            <span
                                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"
                            ></span>
                        </span>
                    {:else}
                        <span
                            class={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${stepStyles[step.kind]}`}
                        >
                            {i + 1}
                        </span>
                    {/if}
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
                                {step.link.text} →
                            </a>
                        {/if}
                    </div>
                </li>
            {/each}
        </ol>
    </div>
{/if}
