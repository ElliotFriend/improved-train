<script lang="ts">
    interface Props {
        amount: string;
        blinding: string;
        busy: boolean;
        depositing: boolean;
        lastDepositHash: string | null;
        onDeposit: () => void;
    }

    let {
        amount = $bindable(),
        blinding = $bindable(),
        busy,
        depositing,
        lastDepositHash,
        onDeposit,
    }: Props = $props();
</script>

<div class="rounded-lg border border-gray-200 bg-white p-4">
    <h2 class="text-sm font-semibold text-gray-700">Deposit XLM into the pool</h2>
    <p class="mt-1 text-xs text-gray-500">
        Creates new notes you can later spend privately. Requires your address to be registered in
        the ASP membership tree first.
    </p>
    <div class="mt-3 flex items-end gap-3">
        <label class="flex-1">
            <span class="block text-xs font-medium text-gray-600">Amount (XLM)</span>
            <input
                type="text"
                inputmode="decimal"
                bind:value={amount}
                disabled={depositing}
                class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
            />
        </label>
        <label class="flex-1">
            <span class="block text-xs font-medium text-gray-600">Membership blinding (BigInt)</span
            >
            <input
                type="text"
                bind:value={blinding}
                disabled={depositing}
                class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
            />
        </label>
        <button
            class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            onclick={onDeposit}
            disabled={busy}
        >
            {depositing ? 'Working…' : 'Deposit'}
        </button>
    </div>
    {#if lastDepositHash}
        <div class="mt-2 text-xs text-gray-500">
            Last deposit:
            <a
                class="underline"
                target="_blank"
                rel="noopener"
                href={`https://stellar.expert/explorer/testnet/tx/${lastDepositHash}`}
                >{lastDepositHash.slice(0, 16)}…</a
            >
        </div>
    {/if}
</div>
