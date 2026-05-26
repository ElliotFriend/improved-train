<script lang="ts">
    import { onMount } from 'svelte';

    import type { WebClient } from '$lib/spp/types';

    type Phase = 'init' | 'ready' | 'working' | 'done' | 'error';

    let phase = $state<Phase>('init');
    let statusMsg = $state('Loading WASM…');
    let errorMsg = $state('');

    let secret = $state('');
    let blinding = $state('1');

    let nurseAddress = $state('');
    let notePub = $state('');
    let encPub = $state('');
    let aspLeafHex = $state('');
    let aspInsertHash = $state<string | null>(null);

    let client = $state<WebClient | null>(null);

    const RPC_URL = 'https://soroban-testnet.stellar.org';
    const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

    function normalizePubkeyHex(raw: string): string {
        let hex = raw.startsWith('0x') ? raw.slice(2) : raw;
        try {
            hex = BigInt(raw).toString(16);
        } catch {
            // raw was already hex without prefix; keep as-is
        }
        return '0x' + hex.padStart(64, '0');
    }

    onMount(async () => {
        try {
            const { initializeWasm } = await import('$lib/spp/wasm-facade');
            const handle = await initializeWasm(RPC_URL);
            client = handle.webClient;
            statusMsg = 'WASM ready';
            phase = 'ready';

            // Allow secret + blinding via URL hash (so they don't hit server logs):
            //   /setup-nurse#secret=S...&blinding=1
            const hash = window.location.hash.replace(/^#/, '');
            if (hash) {
                const params = new URLSearchParams(hash);
                const s = params.get('secret');
                const b = params.get('blinding');
                if (s) secret = s;
                if (b) blinding = b;
                if (s) {
                    // Auto-run when secret is provided in the URL.
                    await runSetup();
                }
            }
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    });

    async function runSetup(): Promise<void> {
        try {
            if (!client) throw new Error('WASM not ready');
            if (!secret.trim()) throw new Error('Stellar secret required');
            phase = 'working';
            errorMsg = '';
            aspInsertHash = null;

            const sdk = await import('@stellar/stellar-sdk');
            const keypair = sdk.Keypair.fromSecret(secret.trim());
            nurseAddress = keypair.publicKey();

            const encoder = new TextEncoder();
            // stellar-sdk's typings say Buffer, but the runtime accepts any
            // Uint8Array (noble-ed25519 internally). Cast to satisfy TS in the
            // browser where Node's Buffer global isn't defined.
            const toBuf = (s: string) => encoder.encode(s) as unknown as Buffer;
            statusMsg = 'Signing spending-key message…';
            const spendingSig = keypair.sign(toBuf(client.spendingKeyMessage()));
            statusMsg = 'Signing encryption-key message…';
            const encryptionSig = keypair.sign(toBuf(client.encryptionDerivationMessage()));

            statusMsg = 'Deriving privacy keys…';
            await client.deriveAndSaveUserKeys(
                nurseAddress,
                new Uint8Array(spendingSig),
                new Uint8Array(encryptionSig),
            );
            const keys = await client.getUserKeys(nurseAddress);
            if (!keys?.noteKeypair?.public || !keys?.encryptionKeypair?.public) {
                throw new Error('Failed to read freshly-derived keys');
            }
            notePub = normalizePubkeyHex(keys.noteKeypair.public);
            encPub = normalizePubkeyHex(keys.encryptionKeypair.public);

            statusMsg = 'Computing ASP membership leaf…';
            const blindingBi = BigInt(blinding.trim() || '0');
            aspLeafHex = await client.deriveAspUserLeaf(blindingBi, notePub);

            statusMsg = 'Registering nurse in ASP membership (signed locally)…';
            const cfg = client.contractConfig();
            const aspClient = await sdk.contract.Client.from({
                rpcUrl: RPC_URL,
                networkPassphrase: NETWORK_PASSPHRASE,
                publicKey: nurseAddress,
                contractId: cfg.asp_membership,
                signTransaction: (async (xdrStr: string) => {
                    const tx = sdk.TransactionBuilder.fromXDR(xdrStr, NETWORK_PASSPHRASE);
                    tx.sign(keypair);
                    return { signedTxXdr: tx.toXDR(), signerAddress: nurseAddress };
                }) as never,
                signAuthEntry: (async (entryXdr: string) => {
                    const entry = sdk.xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
                    const server = new sdk.rpc.Server(RPC_URL);
                    const { sequence } = await server.getLatestLedger();
                    const validUntilLedger = sequence + 1000;
                    const signedEntry = await sdk.authorizeEntry(
                        entry,
                        keypair,
                        validUntilLedger,
                        NETWORK_PASSPHRASE,
                    );
                    return {
                        signedAuthEntry: signedEntry.toXDR('base64'),
                        signerAddress: nurseAddress,
                    };
                }) as never,
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tx = await (aspClient as any).insert_leaf({ leaf: BigInt(aspLeafHex) });
            const sent = await tx.signAndSend();
            const hash: string | null =
                sent?.sendTransactionResponse?.hash ?? sent?.hash ?? sent?.result?.hash ?? null;
            aspInsertHash = hash;

            statusMsg = hash
                ? `ASP leaf registered (tx ${hash.slice(0, 12)}…)`
                : 'ASP leaf already present';
            phase = 'done';
        } catch (err) {
            phase = 'error';
            const msg = err instanceof Error ? err.message : String(err);
            errorMsg = msg;
            // "leaf already exists" is fine — keys are still usable, just skip the ASP step.
            if (/already|exists|duplicate/i.test(msg) && notePub && encPub) {
                statusMsg = 'ASP leaf already registered; reusing.';
                phase = 'done';
            }
        }
    }

    const envBlock = $derived(
        nurseAddress && notePub && encPub
            ? `A2A_NURSE_PUBLIC="${nurseAddress}"\n` +
                  `A2A_NURSE_NOTE_PUBKEY="${notePub}"\n` +
                  `A2A_NURSE_ENC_PUBKEY="${encPub}"\n`
            : '',
    );
</script>

<div class="space-y-6">
    <div>
        <div class="text-sm font-medium text-purple-600">Ops</div>
        <h1 class="text-2xl font-bold tracking-tight">Setup Nurse Agent</h1>
        <p class="mt-1 text-sm text-gray-500">
            One-shot derivation of the nurse agent's privacy-pool keys + ASP membership
            registration. Re-runnable; deterministic from the secret. Signs locally with
            <code>@stellar/stellar-sdk</code> (no Freighter). For browser-only execution see
            <code>scripts/setup-nurse.sh</code>.
        </p>
    </div>

    <div class="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
        <div class="font-medium text-gray-700">Status</div>
        <div class="break-all text-gray-600">{statusMsg}</div>
        {#if errorMsg}
            <div class="mt-1 text-red-700">Error: {errorMsg}</div>
        {/if}
    </div>

    {#if phase === 'init'}
        <p class="text-sm text-gray-500">Loading WASM…</p>
    {:else}
        <div class="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
            <label class="block">
                <span class="block text-xs font-medium text-gray-600"
                    >Stellar secret (S…) for the nurse account</span
                >
                <input
                    type="password"
                    bind:value={secret}
                    placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    disabled={phase === 'working'}
                    class="mt-1 block w-full rounded-md border-gray-300 font-mono text-sm shadow-sm"
                />
            </label>
            <label class="block">
                <span class="block text-xs font-medium text-gray-600"
                    >ASP membership blinding (BigInt)</span
                >
                <input
                    type="text"
                    bind:value={blinding}
                    disabled={phase === 'working'}
                    class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                />
            </label>
            <div class="flex justify-end">
                <button
                    class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={runSetup}
                    disabled={phase === 'working' || !secret.trim()}
                >
                    {phase === 'working' ? 'Working…' : 'Derive & register'}
                </button>
            </div>
        </div>
    {/if}

    {#if envBlock}
        <div class="rounded-lg border border-green-200 bg-green-50 p-4">
            <h2 class="mb-2 text-sm font-semibold text-green-800">
                Done. Paste this into your <code>.env</code>:
            </h2>
            <pre class="overflow-x-auto rounded bg-white p-3 text-xs">{envBlock}</pre>
            {#if aspInsertHash}
                <div class="mt-2 text-xs text-gray-600">
                    ASP insert tx:
                    <a
                        class="underline"
                        target="_blank"
                        rel="noopener"
                        href={`https://stellar.expert/explorer/testnet/tx/${aspInsertHash}`}
                        >{aspInsertHash.slice(0, 16)}…</a
                    >
                </div>
            {/if}
            <div class="mt-2 text-xs text-gray-500">
                Restart the dev server so the new env vars are picked up.
            </div>
        </div>
    {/if}
</div>
