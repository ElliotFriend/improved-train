<script lang="ts">
    interface Props {
        question: string;
        busy: boolean;
        asking: boolean;
        onAsk: () => void;
    }

    let { question = $bindable(), busy, asking, onAsk }: Props = $props();
</script>

<div class="rounded-lg border border-gray-200 bg-white p-4">
    <h2 class="text-sm font-semibold text-gray-700">Ask the nurse</h2>
    <textarea
        id="q"
        bind:value={question}
        rows="3"
        disabled={asking}
        class="mt-2 block w-full rounded-md border-gray-300 text-sm shadow-sm"
    ></textarea>
    <div class="mt-3 flex justify-end">
        <button
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            onclick={onAsk}
            disabled={busy || !question.trim()}
        >
            {asking ? 'Working…' : 'Ask nurse'}
        </button>
    </div>
</div>
