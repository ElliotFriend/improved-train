<script lang="ts">
    interface Props {
        busy: boolean;
        registering: boolean;
        onRegister: () => void;
    }

    let { busy, registering, onRegister }: Props = $props();
</script>

<div class="rounded-lg border border-gray-200 bg-white p-4">
    <h2 class="text-sm font-semibold text-gray-700">Register with ASP membership</h2>
    <p class="mt-1 text-xs text-gray-500">
        One-time: compute your ASP membership leaf as
        <code>Poseidon(blinding, note_pubkey)</code> and insert it into the
        <code>asp_membership</code> contract so the pool will accept your deposits and withdrawals.
        Admin-only-insert is disabled on this pool, so you can self-register. Use the same
        <em>Membership blinding</em> for register + deposit + withdraw.
    </p>
    <div class="mt-3 flex justify-end">
        <button
            class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            onclick={onRegister}
            disabled={busy}
        >
            {registering ? 'Working…' : 'Register with privacy pool'}
        </button>
    </div>
</div>
