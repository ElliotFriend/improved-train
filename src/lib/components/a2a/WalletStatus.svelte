<script lang="ts">
    import type { ContractConfig } from '$lib/spp/types';

    interface Props {
        address: string;
        noteCount: number | null;
        balanceStroops: bigint;
        contractCfg: ContractConfig | null;
    }

    let { address, noteCount, balanceStroops, contractCfg }: Props = $props();

    const balanceXlm = $derived((Number(balanceStroops) / 1e7).toFixed(4));
</script>

<div class="space-y-1 rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-700">
    <div>
        Connected as <code>{address.slice(0, 6)}…{address.slice(-4)}</code>
    </div>
    <div>
        Notes in pool: <code>{noteCount ?? '?'}</code> · balance:
        <code>{balanceXlm} XLM</code>
    </div>
    {#if contractCfg}
        <div class="text-gray-500">
            pool <code>{contractCfg.pool.slice(0, 6)}…{contractCfg.pool.slice(-4)}</code> ·
            ASP-membership
            <code
                >{contractCfg.asp_membership.slice(0, 6)}…{contractCfg.asp_membership.slice(
                    -4,
                )}</code
            >
        </div>
    {/if}
</div>
