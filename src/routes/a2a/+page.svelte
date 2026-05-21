<script lang="ts">
    import { onMount } from 'svelte';
    import Markdown from '@humanspeak/svelte-markdown';

    type Phase =
        | 'init'
        | 'no-freighter'
        | 'wallet'
        | 'keys'
        | 'ready'
        | 'registering'
        | 'depositing'
        | 'asking'
        | 'replied'
        | 'error';

    interface ContractConfig {
        pool: string;
        asp_membership: string;
        asp_non_membership: string;
        verifier: string;
    }

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
    let balanceStroops = $state<bigint>(0n);
    let contractCfg = $state<ContractConfig | null>(null);
    let depositAmountXlm = $state('10');
    let membershipBlinding = $state('0'); // BigInt string; 0 if no ASP-blinding scheme
    let question = $state(
        "I've had a dull headache and mild dizziness on and off for three days. No fever. Should I worry?",
    );
    let advice = $state('');
    let txHash = $state<string | null>(null);
    let lastDepositHash = $state<string | null>(null);

    // The runtime WASM client (typed as unknown — see $lib/spp/web.d.ts for the
    // surface we care about).
    type UserKeys = {
        noteKeypair: { private: string; public: string };
        encryptionKeypair: { private: string; public: string };
    };
    type WebClient = {
        getUserKeys(addr: string): Promise<UserKeys | null>;
        getUserNotes(addr: string, limit: number): Promise<{ id: string; amount: string }[]>;
        contractConfig(): ContractConfig;
        deriveAspUserLeaf(membershipBlinding: bigint, pubkeyHex: string): Promise<string>;
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
            spendingSig: Uint8Array,
            encryptionSig: Uint8Array,
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
            client = handle.webClient;
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
        if (!contractCfg) {
            contractCfg = client.contractConfig();
        }
        const keys = await client.getUserKeys(address);
        if (!keys) {
            phase = 'keys';
            return;
        }
        const notes = await client.getUserNotes(address, 50);
        noteCount = notes?.length ?? 0;
        balanceStroops = (notes ?? []).reduce((acc, n) => acc + BigInt(n.amount), 0n);
        phase = 'ready';
    }

    function xlmToStroops(s: string): bigint {
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
        return BigInt(Math.round(n * 10_000_000));
    }

    function normalizePubkeyHex(raw: string): string {
        let hex = raw.startsWith('0x') ? raw.slice(2) : raw;
        // BigInt() handles both decimal and 0x-prefixed hex; fall back to literal hex.
        try {
            hex = BigInt(raw).toString(16);
        } catch {
            // raw was already hex without prefix; keep as-is
        }
        return '0x' + hex.padStart(64, '0');
    }

    async function registerAsp() {
        try {
            if (!client || !address) throw new Error('not ready');
            const blinding = BigInt(membershipBlinding.trim() || '0');
            const cfg = contractCfg ?? client.contractConfig();
            phase = 'registering';
            errorMsg = '';

            statusMsg = 'Reading note public key…';
            const keys = await client.getUserKeys(address);
            if (!keys?.noteKeypair?.public) {
                throw new Error('user keys not found — derive them first');
            }
            const pubkeyHex = normalizePubkeyHex(keys.noteKeypair.public);

            statusMsg = `Computing ASP leaf for blinding=${blinding}…`;
            const leafHex = await client.deriveAspUserLeaf(blinding, pubkeyHex);
            const leafValue = BigInt(leafHex);

            statusMsg = `Inserting leaf into ASP membership ${cfg.asp_membership.slice(0, 8)}…`;
            const sdk = await import('@stellar/stellar-sdk');
            const wallet = await import('$lib/spp/wallet.js');
            const networkPassphrase = 'Test SDF Network ; September 2015';
            const aspClient = await sdk.contract.Client.from({
                rpcUrl: RPC_URL,
                networkPassphrase,
                publicKey: address,
                contractId: cfg.asp_membership,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                signTransaction: (async (xdr: string, extra: any = {}) =>
                    wallet.signWalletTransaction(xdr, {
                        address,
                        networkPassphrase,
                        ...extra,
                    })) as never,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                signAuthEntry: (async (xdr: string, extra: any = {}) =>
                    wallet.signWalletAuthEntry(xdr, {
                        address,
                        networkPassphrase,
                        ...extra,
                    })) as never,
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tx = await (aspClient as any).insert_leaf({ leaf: leafValue });
            statusMsg = 'Awaiting Freighter signature…';
            const sent = await tx.signAndSend();
            const hash: string | null =
                sent?.sendTransactionResponse?.hash ?? sent?.hash ?? sent?.result?.hash ?? null;

            statusMsg = hash
                ? `ASP leaf registered (tx ${hash.slice(0, 12)}…). You can now deposit.`
                : 'ASP leaf registered.';
            // Brief delay for the indexer to pick up the new ASP root, then refresh.
            await new Promise((r) => setTimeout(r, 1500));
            await refreshState();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            phase = 'ready';
        }
    }

    async function deposit() {
        try {
            if (!client || !address) throw new Error('not ready');
            const amountStroops = xlmToStroops(depositAmountXlm);
            const blinding = BigInt(membershipBlinding.trim() || '0');
            const cfg = contractCfg ?? client.contractConfig();
            phase = 'depositing';
            errorMsg = '';
            statusMsg = 'Building deposit proof…';

            // 2-output split: put everything in note 0, leave note 1 empty.
            const outputs: bigint[] = [amountStroops, 0n];
            const proved = await client.proveDeposit(address, blinding, amountStroops, outputs, (p) => {
                if (p?.message) statusMsg = p.message;
            });
            if (proved == null) {
                throw new Error(
                    'proveDeposit returned null — patient address is probably not registered in the ASP membership tree yet. ' +
                        `Ask the ASP admin to insert a leaf for blinding=${blinding} and your pubkey.`,
                );
            }

            const { submitProvedPoolTransact } = await import('$lib/spp/stellar.js');
            statusMsg = 'Awaiting Freighter signature…';
            const networkPassphrase = 'Test SDF Network ; September 2015';
            const hash = await submitProvedPoolTransact(
                proved,
                {
                    address,
                    rpcUrl: RPC_URL,
                    networkPassphrase,
                    poolContractId: cfg.pool,
                },
                {
                    onStatus: (p: { message?: string }) => {
                        if (p?.message) statusMsg = p.message;
                    },
                },
            );
            lastDepositHash = hash;
            statusMsg = `Deposit submitted (${hash.slice(0, 12)}…). Waiting for indexer to pick up the new notes…`;
            // The storage worker indexer is async; give it a couple seconds, then refresh.
            await new Promise((r) => setTimeout(r, 2500));
            await refreshState();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            phase = 'ready'; // recover so user can retry
        }
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
            // Freighter returns signedMessage as a base64 string; WASM wants raw
            // 64-byte ed25519 signatures (Uint8Array).
            const toBytes = (sig: unknown): Uint8Array => {
                if (sig instanceof Uint8Array) return sig;
                if (typeof sig === 'string') {
                    return Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
                }
                throw new Error(`unexpected signature shape: ${typeof sig}`);
            };
            await client.deriveAndSaveUserKeys(
                address,
                toBytes(sk.signedMessage),
                toBytes(ek.signedMessage),
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
                BigInt(membershipBlinding.trim() || '0'), // same blinding the user registered with
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
    {:else if phase === 'ready' || phase === 'asking' || phase === 'replied' || phase === 'depositing' || phase === 'registering'}
        <div class="space-y-1 rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-700">
            <div>
                Connected as <code>{address?.slice(0, 6)}…{address?.slice(-4)}</code>
            </div>
            <div>
                Notes in pool: <code>{noteCount ?? '?'}</code> · balance:
                <code>{(Number(balanceStroops) / 1e7).toFixed(4)} XLM</code>
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

        <div class="rounded-lg border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-700">Register with ASP membership</h2>
            <p class="mt-1 text-xs text-gray-500">
                One-time: compute your ASP membership leaf as
                <code>Poseidon(blinding, note_pubkey)</code> and insert it into the
                <code>asp_membership</code> contract so the pool will accept your deposits and
                withdrawals. Admin-only-insert is disabled on this pool, so you can self-register.
                Use the same <em>Membership blinding</em> for register + deposit + withdraw.
            </p>
            <div class="mt-3 flex justify-end">
                <button
                    class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={registerAsp}
                    disabled={phase === 'registering' ||
                        phase === 'depositing' ||
                        phase === 'asking'}
                >
                    {phase === 'registering' ? 'Working…' : 'Register with privacy pool'}
                </button>
            </div>
        </div>

        <div class="rounded-lg border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-700">Deposit XLM into the pool</h2>
            <p class="mt-1 text-xs text-gray-500">
                Creates new notes you can later spend privately. Requires your address to be
                registered in the ASP membership tree first.
            </p>
            <div class="mt-3 flex items-end gap-3">
                <label class="flex-1">
                    <span class="block text-xs font-medium text-gray-600">Amount (XLM)</span>
                    <input
                        type="text"
                        inputmode="decimal"
                        bind:value={depositAmountXlm}
                        disabled={phase === 'depositing'}
                        class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    />
                </label>
                <label class="flex-1">
                    <span class="block text-xs font-medium text-gray-600"
                        >Membership blinding (BigInt)</span
                    >
                    <input
                        type="text"
                        bind:value={membershipBlinding}
                        disabled={phase === 'depositing'}
                        class="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    />
                </label>
                <button
                    class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={deposit}
                    disabled={phase === 'depositing' || phase === 'asking'}
                >
                    {phase === 'depositing' ? 'Working…' : 'Deposit'}
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

        <div class="rounded-lg border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-700">Ask the nurse</h2>
            <textarea
                id="q"
                bind:value={question}
                rows="3"
                disabled={phase === 'asking' || phase === 'depositing'}
                class="mt-2 block w-full rounded-md border-gray-300 text-sm shadow-sm"
            ></textarea>
            <div class="mt-3 flex justify-end">
                <button
                    class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={askNurse}
                    disabled={phase === 'asking' || phase === 'depositing' || !question.trim()}
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
