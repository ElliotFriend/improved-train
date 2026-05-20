<script lang="ts">
    import { onMount } from 'svelte';
    import Markdown from '@humanspeak/svelte-markdown';

    type Phase =
        | 'init'
        | 'no-freighter'
        | 'wallet'
        | 'keys'
        | 'ready'
        | 'asking'
        | 'replied'
        | 'error';

    interface Challenge {
        scheme: string;
        network: string;
        recipient: string;
        amountStroops: string;
        pool: string;
        aspMembership: string;
        aspNonMembership: string;
        description: string;
    }

    let phase = $state<Phase>('init');
    let statusMsg = $state('Loading WASM…');
    let errorMsg = $state('');

    let address = $state<string | null>(null);
    let noteCount = $state<number | null>(null);
    let question = $state(
        "I've had a dull headache and mild dizziness on and off for three days. No fever. Should I worry?",
    );
    let advice = $state('');
    let txHash = $state<string | null>(null);

    // The runtime WASM client (typed as unknown — see $lib/spp/web.d.ts for the
    // surface we care about).
    type WebClient = {
        getUserKeys(addr: string): Promise<unknown>;
        getUserNotes(addr: string, limit: number): Promise<{ id: string; amount: string }[]>;
        proveWithdraw(
            addr: string,
            membershipBlinding: bigint,
            recipient: string,
            inputNoteIds: string[],
            onStatus?: (p: { stage?: string; message?: string }) => void,
        ): Promise<unknown>;
        spendingKeyMessage(): string;
        encryptionDerivationMessage(): string;
        deriveAndSaveUserKeys(
            addr: string,
            spendingSig: string,
            encryptionSig: string,
        ): Promise<void>;
        proveDeposit(
            addr: string,
            membershipBlinding: bigint,
            amountStroops: bigint,
            outputAmounts: bigint[],
            onStatus?: (p: { stage?: string; message?: string }) => void,
        ): Promise<unknown>;
    };
    let client = $state<WebClient | null>(null);

    const RPC_URL = 'https://soroban-testnet.stellar.org';

    onMount(async () => {
        try {
            const { initializeWasm } = await import('$lib/spp/wasm-facade.js');
            const handle = await initializeWasm(RPC_URL);
            client = handle.client();
            statusMsg = 'WASM ready';

            // Probe Freighter
            const fg = await import('@stellar/freighter-api');
            const conn = await fg.isConnected();
            if (conn?.error || !conn?.isConnected) {
                phase = 'no-freighter';
                statusMsg = 'Freighter wallet not detected.';
                return;
            }
            phase = 'wallet';
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    });

    async function connectWallet() {
        try {
            statusMsg = 'Requesting wallet access…';
            const fg = await import('@stellar/freighter-api');
            const access = await fg.requestAccess();
            if (access.error) throw new Error(access.error);
            address = access.address;
            statusMsg = `Connected ${address!.slice(0, 6)}…${address!.slice(-4)}`;
            await refreshState();
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    }

    async function refreshState() {
        if (!client || !address) return;
        const keys = await client.getUserKeys(address);
        if (!keys) {
            phase = 'keys';
            return;
        }
        const notes = await client.getUserNotes(address, 50);
        noteCount = notes?.length ?? 0;
        phase = 'ready';
    }

    async function deriveKeys() {
        try {
            if (!client || !address) throw new Error('not ready');
            const fg = await import('@stellar/freighter-api');
            statusMsg = 'Signing spending-key message…';
            const sk = await fg.signMessage(client.spendingKeyMessage(), { address });
            if (sk.error) throw new Error(sk.error);
            statusMsg = 'Signing encryption-key message…';
            const ek = await fg.signMessage(client.encryptionDerivationMessage(), { address });
            if (ek.error) throw new Error(ek.error);
            statusMsg = 'Deriving keys…';
            // freighter-api returns { signedMessage: Uint8Array | string }; convert to base64
            const toB64 = (sig: unknown) =>
                typeof sig === 'string' ? sig : btoa(String.fromCharCode(...(sig as Uint8Array)));
            await client.deriveAndSaveUserKeys(
                address,
                toB64(sk.signedMessage),
                toB64(ek.signedMessage),
            );
            await refreshState();
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    }

    async function askNurse() {
        try {
            if (!client || !address) throw new Error('not ready');
            phase = 'asking';
            statusMsg = 'Fetching 402 challenge…';
            const initial = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question }),
            });
            if (initial.status !== 402) {
                throw new Error(`expected 402, got ${initial.status}`);
            }
            const { challenge }: { challenge: Challenge } = await initial.json();
            statusMsg = `Pool ${challenge.pool.slice(0, 6)}…  amount ${challenge.amountStroops} stroops`;

            // Pick input notes (greedy)
            const notes = await client.getUserNotes(address, 50);
            const need = BigInt(challenge.amountStroops);
            const picked: { id: string; amount: string }[] = [];
            let sum = 0n;
            for (const n of notes ?? []) {
                if (sum >= need) break;
                if (picked.length >= 2) break;
                picked.push(n);
                sum += BigInt(n.amount);
            }
            if (sum < need) {
                throw new Error(
                    `Insufficient notes: have ${sum} stroops, need ${need}. Deposit some XLM first.`,
                );
            }

            statusMsg = 'Generating Groth16 proof in browser (this can take ~10s)…';
            const proved = await client.proveWithdraw(
                address,
                0n, // membership blinding -- TODO derive from ASP-registered key
                challenge.recipient,
                picked.map((n) => n.id),
                (p) => {
                    if (p?.message) statusMsg = p.message;
                },
            );
            if (proved == null) {
                throw new Error(
                    'proveWithdraw returned null (ASP registration or membership-blinding mismatch?)',
                );
            }

            const { submitProvedPoolTransact } = await import('$lib/spp/stellar.js');
            statusMsg = 'Awaiting Freighter signature…';
            const networkPassphrase = 'Test SDF Network ; September 2015';
            const submittedHash = await submitProvedPoolTransact(
                proved,
                {
                    address,
                    rpcUrl: RPC_URL,
                    networkPassphrase,
                    poolContractId: challenge.pool,
                },
                {
                    onStatus: (p: { message?: string }) => {
                        if (p?.message) statusMsg = p.message;
                    },
                },
            );
            txHash = submittedHash;

            statusMsg = 'Verifying settlement with nurse…';
            const final = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-payment-tx': submittedHash },
                body: JSON.stringify({ question }),
            });
            if (!final.ok) {
                throw new Error(`consult failed (${final.status}): ${await final.text()}`);
            }
            advice = (await final.json()).advice;
            phase = 'replied';
            statusMsg = `Replied (tx ${submittedHash.slice(0, 12)}…)`;
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    }
</script>

<div class="space-y-6">
    <div>
        <div class="text-sm font-medium text-purple-600">Agent-to-Agent</div>
        <h1 class="text-2xl font-bold tracking-tight">Private Medical Consult</h1>
        <p class="mt-1 text-sm text-gray-500">
            Patient agent runs in your browser. Privacy proof is generated locally via the
            Nethermind stellar-private-payments WASM bundle; the withdrawal is signed with
            Freighter and submitted via Soroban RPC. The nurse server only verifies the
            transaction on-chain and returns Claude-generated guidance.
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
    {:else if phase === 'no-freighter'}
        <div class="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Freighter wallet is required for this demo.
            <a class="underline" href="https://www.freighter.app/" target="_blank" rel="noopener"
                >Install Freighter</a
            >
            and reload this page.
        </div>
    {:else if phase === 'wallet'}
        <button
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            onclick={connectWallet}
        >
            Connect Freighter
        </button>
    {:else if phase === 'keys'}
        <div class="space-y-3 text-sm">
            <p>
                One-time setup: derive privacy keys by signing two messages with your wallet.
                Freighter will prompt twice.
            </p>
            <button
                class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                onclick={deriveKeys}
            >
                Derive privacy keys
            </button>
        </div>
    {:else if phase === 'ready' || phase === 'asking' || phase === 'replied'}
        <div class="rounded-md bg-white p-3 text-xs text-gray-700">
            Connected as <code>{address?.slice(0, 6)}…{address?.slice(-4)}</code> · notes in pool:
            <code>{noteCount ?? '?'}</code>
        </div>

        <div>
            <label for="q" class="block text-sm font-medium text-gray-700">Ask the nurse agent</label
            >
            <textarea
                id="q"
                bind:value={question}
                rows="3"
                disabled={phase === 'asking'}
                class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
            ></textarea>
            <div class="mt-3 flex justify-end">
                <button
                    class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={askNurse}
                    disabled={phase === 'asking' || !question.trim()}
                >
                    {phase === 'asking' ? 'Working…' : 'Ask nurse'}
                </button>
            </div>
        </div>

        {#if txHash}
            <div class="text-xs text-gray-500">
                Settlement tx:
                <a
                    class="underline"
                    target="_blank"
                    rel="noopener"
                    href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}>{txHash.slice(0, 16)}…</a
                >
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
    {:else if phase === 'error'}
        <div class="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Something went wrong. See status above.
        </div>
    {/if}
</div>
