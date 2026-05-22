<script lang="ts">
    import Markdown from '@humanspeak/svelte-markdown';

    interface Props {
        advice: string;
    }

    let { advice }: Props = $props();
</script>

{#if advice}
    <div class="rounded-lg border border-green-200 bg-green-50 p-5">
        <h2 class="mb-3 text-sm font-semibold text-green-800">Nurse Agent Response</h2>
        <div class="prose prose-sm max-w-none text-gray-900">
            <Markdown source={advice} />
        </div>
    </div>
{/if}
