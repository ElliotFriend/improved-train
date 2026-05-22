<script lang="ts">
    import { onMount } from 'svelte';

    import type { ContractConfig, WebClient } from '$lib/spp/types';
    import type { FlowStep } from '$lib/components/a2a/flow';
    import WalletStatus from '$lib/components/a2a/WalletStatus.svelte';
    import RegisterAspCard from '$lib/components/a2a/RegisterAspCard.svelte';
    import DepositCard from '$lib/components/a2a/DepositCard.svelte';
    import AskNurseCard from '$lib/components/a2a/AskNurseCard.svelte';
    import FlowSteps from '$lib/components/a2a/FlowSteps.svelte';
    import AdviceCard from '$lib/components/a2a/AdviceCard.svelte';

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

    interface Challenge {
        scheme: string;
        network: string;
        recipient: string;
        amountStroops: string;
        pool: string;
        aspMembership: string;
        aspNonMembership: string;
        nurseNotePubkey: string;
        nurseEncPubkey: string;
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
    let membershipBlinding = $state('0');
    let question = $state(
        "I've had a dull headache and mild dizziness on and off for three days. No fever. Should I worry?",
    );
    let advice = $state('');
    let lastDepositHash = $state<string | null>(null);
    let aspRegisteredLocally = $state(false);

    let client = $state<WebClient | null>(null);

    let flowSteps = $state<FlowStep[]>([]);

    const RPC_URL = 'https://soroban-testnet.stellar.org';
    const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

    const busy = $derived(phase === 'registering' || phase === 'depositing' || phase === 'asking');
    const alreadyRegistered = $derived(
        (noteCount !== null && noteCount > 0) || aspRegisteredLocally,
    );

    function aspFlagKey(addr: string): string {
        return `asp-registered-${addr}`;
    }

    function pushStep(step: FlowStep): void {
        if (flowSteps.length > 0) {
            flowSteps[flowSteps.length - 1].pending = false;
        }
        flowSteps.push(step);
    }

    function updateLastStep(patch: Partial<FlowStep>): void {
        const i = flowSteps.length - 1;
        if (i < 0) return;
        flowSteps[i] = { ...flowSteps[i], ...patch };
    }

    function finalizeFlow(): void {
        if (flowSteps.length > 0) flowSteps[flowSteps.length - 1].pending = false;
    }

    function startFlow(): void {
        flowSteps = [];
        advice = '';
        errorMsg = '';
    }

    /**
     * Map a status callback from the prover or stellar.ts into a FlowStep.
     * Consecutive updates for the same stage update the existing step in place.
     */
    function handleSubmitStatus(p: {
        stage?: string;
        message?: string;
        current?: number;
        total?: number;
    }): void {
        const stage = p.stage ?? 'protocol';
        const labels: Record<string, { label: string; kind: FlowStep['kind'] }> = {
            build_tx: { label: 'Building & simulating Soroban tx', kind: 'protocol' },
            sign_auth: { label: 'Signing auth entry', kind: 'sign' },
            sign_tx: { label: 'Signing transaction', kind: 'sign' },
            submit: { label: 'Submitting to Soroban RPC', kind: 'submit' },
            confirm: { label: 'Confirming on ledger', kind: 'submit' },
        };
        const entry = labels[stage] ?? {
            label: p.message ?? stage,
            kind: 'protocol' as FlowStep['kind'],
        };
        const detail = p.current && p.total ? `${p.current}/${p.total}` : undefined;

        const last = flowSteps[flowSteps.length - 1];
        if (last && last.label === entry.label) {
            updateLastStep({ detail });
            return;
        }
        pushStep({ kind: entry.kind, label: entry.label, detail, pending: true });
    }

    function handleProveStatus(p: { stage?: string; message?: string }): void {
        const msg = p?.message;
        if (!msg) return;
        const last = flowSteps[flowSteps.length - 1];
        if (last && last.label === 'Generating Groth16 proof') {
            updateLastStep({ detail: msg });
            return;
        }
        pushStep({
            kind: 'protocol',
            label: 'Generating Groth16 proof',
            detail: msg,
            pending: true,
        });
    }

    onMount(async () => {
        try {
            const { initializeWasm } = await import('$lib/spp/wasm-facade');
            const handle = await initializeWasm(RPC_URL);
            client = handle.webClient;
            statusMsg = 'WASM ready';

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

    async function connectWallet(): Promise<void> {
        try {
            statusMsg = 'Requesting wallet access…';
            const fg = await import('@stellar/freighter-api');
            const access = await fg.requestAccess();
            if (access.error) throw new Error(access.error);
            address = access.address;
            if (typeof localStorage !== 'undefined') {
                aspRegisteredLocally = localStorage.getItem(aspFlagKey(address)) === '1';
            }
            statusMsg = `Connected ${address.slice(0, 6)}…${address.slice(-4)}`;
            await refreshState();
        } catch (err) {
            phase = 'error';
            errorMsg = err instanceof Error ? err.message : String(err);
        }
    }

    async function refreshState(): Promise<void> {
        if (!client || !address) return;
        if (!contractCfg) contractCfg = client.contractConfig();
        const keys = await client.getUserKeys(address);
        if (!keys) {
            phase = 'keys';
            return;
        }
        const notes = await client.getUserNotes(address, 50);
        const unspent = (notes ?? []).filter((n) => !n.spent);
        noteCount = unspent.length;
        balanceStroops = unspent.reduce((acc, n) => acc + BigInt(n.amount), 0n);
        phase = 'ready';
    }

    function xlmToStroops(s: string): bigint {
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
        return BigInt(Math.round(n * 10_000_000));
    }

    function normalizePubkeyHex(raw: string): string {
        let hex = raw.startsWith('0x') ? raw.slice(2) : raw;
        try {
            hex = BigInt(raw).toString(16);
        } catch {
            // raw was already hex without prefix; keep as-is
        }
        return '0x' + hex.padStart(64, '0');
    }

    async function registerAsp(): Promise<void> {
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
            const wallet = await import('$lib/spp/wallet');
            const aspClient = await sdk.contract.Client.from({
                rpcUrl: RPC_URL,
                networkPassphrase: NETWORK_PASSPHRASE,
                publicKey: address,
                contractId: cfg.asp_membership,
                signTransaction: (async (xdrStr: string, extra: Record<string, unknown> = {}) =>
                    wallet.signWalletTransaction(xdrStr, {
                        address: address!,
                        networkPassphrase: NETWORK_PASSPHRASE,
                        ...extra,
                    })) as never,
                signAuthEntry: (async (xdrStr: string, extra: Record<string, unknown> = {}) =>
                    wallet.signWalletAuthEntry(xdrStr, {
                        address: address!,
                        networkPassphrase: NETWORK_PASSPHRASE,
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

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(aspFlagKey(address), '1');
            }
            aspRegisteredLocally = true;

            await new Promise((r) => setTimeout(r, 1500));
            await refreshState();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            phase = 'ready';
        }
    }

    async function deposit(): Promise<void> {
        try {
            if (!client || !address) throw new Error('not ready');
            const amountStroops = xlmToStroops(depositAmountXlm);
            const blinding = BigInt(membershipBlinding.trim() || '0');
            const cfg = contractCfg ?? client.contractConfig();
            phase = 'depositing';
            errorMsg = '';
            statusMsg = 'Building deposit proof…';

            const outputs: bigint[] = [amountStroops, 0n];
            const proved = await client.proveDeposit(
                address,
                blinding,
                amountStroops,
                outputs,
                (p) => {
                    if (p?.message) statusMsg = p.message;
                },
            );
            if (proved == null) {
                throw new Error(
                    'proveDeposit returned null — patient address is probably not registered in the ASP membership tree yet. ' +
                        `Ask the ASP admin to insert a leaf for blinding=${blinding} and your pubkey.`,
                );
            }

            const { submitProvedPoolTransact } = await import('$lib/spp/stellar');
            statusMsg = 'Awaiting Freighter signature…';
            const hash = await submitProvedPoolTransact(
                proved,
                {
                    address,
                    rpcUrl: RPC_URL,
                    networkPassphrase: NETWORK_PASSPHRASE,
                    poolContractId: cfg.pool,
                },
                {
                    onStatus: (p) => {
                        if (p?.message) statusMsg = p.message;
                    },
                },
            );
            lastDepositHash = hash;
            statusMsg = `Deposit submitted (${hash.slice(0, 12)}…). Waiting for indexer to pick up the new notes…`;
            await new Promise((r) => setTimeout(r, 2500));
            await refreshState();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            phase = 'ready';
        }
    }

    async function deriveKeys(): Promise<void> {
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

    async function askNurse(): Promise<void> {
        try {
            if (!client || !address) throw new Error('not ready');
            phase = 'asking';
            startFlow();

            pushStep({
                kind: 'request',
                label: 'POST /api/a2a/consult',
                detail: 'no payment',
                pending: true,
            });
            const initial = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question }),
            });
            if (initial.status !== 402) {
                throw new Error(`expected 402, got ${initial.status}`);
            }
            const { challenge }: { challenge: Challenge } = await initial.json();
            if (!challenge.nurseNotePubkey || !challenge.nurseEncPubkey) {
                throw new Error(
                    'Challenge missing nurse pubkeys — run /setup-nurse and update env vars.',
                );
            }
            const amountXlm = (Number(challenge.amountStroops) / 1e7).toFixed(4);
            pushStep({
                kind: 'challenge',
                label: `402 Payment Required (${challenge.scheme})`,
                detail:
                    `${amountXlm} XLM (in-pool transfer) to nurse ` +
                    `${challenge.nurseNotePubkey.slice(0, 10)}…${challenge.nurseNotePubkey.slice(-4)} ` +
                    `via pool ${challenge.pool.slice(0, 6)}…${challenge.pool.slice(-4)}`,
                link: {
                    href: `https://stellar.expert/explorer/testnet/contract/${challenge.pool}`,
                    text: 'View privacy-pool contract',
                },
                pending: true,
            });

            const notes = await client.getUserNotes(address, 50);
            const need = BigInt(challenge.amountStroops);
            const picked: { id: string; amount: string }[] = [];
            let sum = 0n;
            for (const n of notes ?? []) {
                if (n.spent) continue;
                if (sum >= need) break;
                if (picked.length >= 2) break;
                picked.push(n);
                sum += BigInt(n.amount);
            }
            if (sum < need) {
                throw new Error(
                    `Insufficient unspent notes: have ${sum} stroops, need ${need}. Deposit more XLM.`,
                );
            }
            const change = sum - need;
            pushStep({
                kind: 'protocol',
                label: 'Selected input notes',
                detail:
                    `${picked.length} note(s), ${(Number(sum) / 1e7).toFixed(4)} XLM ` +
                    `(${amountXlm} → nurse, ${(Number(change) / 1e7).toFixed(4)} → change)`,
                pending: true,
            });

            pushStep({
                kind: 'protocol',
                label: 'Generating Groth16 proof',
                detail: 'Building witness & proof in browser (~10s)…',
                pending: true,
            });
            // In-pool transfer: ext_amount = 0 so no XLM leaves the pool.
            // Output 0 → nurse (challenge amount); output 1 → patient (change).
            const patientKeys = await client.getUserKeys(address);
            if (!patientKeys?.noteKeypair?.public || !patientKeys?.encryptionKeypair?.public) {
                throw new Error('patient privacy keys missing — derive them first');
            }
            const patientNotePub = normalizePubkeyHex(patientKeys.noteKeypair.public);
            const patientEncPub = normalizePubkeyHex(patientKeys.encryptionKeypair.public);
            const proved = await client.proveTransact(
                address,
                BigInt(membershipBlinding.trim() || '0'),
                challenge.recipient,
                0n,
                picked.map((n) => n.id),
                [need, change],
                [challenge.nurseNotePubkey, patientNotePub],
                [challenge.nurseEncPubkey, patientEncPub],
                handleProveStatus,
            );
            if (proved == null) {
                throw new Error(
                    'proveTransact returned null (ASP registration or membership-blinding mismatch?)',
                );
            }

            const { submitProvedPoolTransact } = await import('$lib/spp/stellar');
            const submittedHash = await submitProvedPoolTransact(
                proved,
                {
                    address,
                    rpcUrl: RPC_URL,
                    networkPassphrase: NETWORK_PASSPHRASE,
                    poolContractId: challenge.pool,
                },
                { onStatus: handleSubmitStatus },
            );
            pushStep({
                kind: 'settled',
                label: 'Settlement confirmed on ledger',
                detail: `tx ${submittedHash.slice(0, 12)}…`,
                link: {
                    href: `https://stellar.expert/explorer/testnet/tx/${submittedHash}`,
                    text: 'View on Stellar Expert',
                },
                pending: true,
            });

            pushStep({
                kind: 'verify',
                label: 'Re-requesting consult with payment receipt',
                detail: `X-Payment-Tx: ${submittedHash.slice(0, 12)}…`,
                pending: true,
            });
            const final = await fetch('/api/a2a/consult', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-payment-tx': submittedHash },
                body: JSON.stringify({ question }),
            });
            if (!final.ok) {
                throw new Error(`consult failed (${final.status}): ${await final.text()}`);
            }
            advice = (await final.json()).advice;
            pushStep({
                kind: 'data',
                label: 'Nurse agent response received',
                detail: `${advice.length} chars`,
            });
            finalizeFlow();
            phase = 'replied';
            // Refresh notes / balance — the transact burned an input note and
            // produced new output commitments the indexer needs to surface.
            await new Promise((r) => setTimeout(r, 1500));
            await refreshState();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            pushStep({
                kind: 'error',
                label: 'Request failed',
                detail: errorMsg,
            });
            finalizeFlow();
            phase = 'error';
        }
    }
</script>

<div class="space-y-6">
    <div>
        <div class="text-sm font-medium text-purple-600">Agent-to-Agent</div>
        <h1 class="text-2xl font-bold tracking-tight">Private Medical Consult</h1>
        <p class="mt-1 text-sm text-gray-500">
            Patient agent runs in your browser. Privacy proof is generated locally via the
            Nethermind stellar-private-payments WASM bundle; the withdrawal is signed with Freighter
            and submitted via Soroban RPC. The nurse server only verifies the transaction on-chain
            and returns Claude-generated guidance.
        </p>
    </div>

    {#if phase !== 'asking' && phase !== 'replied'}
        <div class="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
            <div class="font-medium text-gray-700">Status</div>
            <div class="break-all text-gray-600">{statusMsg}</div>
            {#if errorMsg}
                <div class="mt-1 text-red-700">Error: {errorMsg}</div>
            {/if}
        </div>
    {/if}

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
    {:else if address && (phase === 'ready' || phase === 'asking' || phase === 'replied' || phase === 'depositing' || phase === 'registering' || phase === 'error')}
        <WalletStatus {address} {noteCount} {balanceStroops} {contractCfg} />

        {#if !alreadyRegistered}
            <RegisterAspCard
                {busy}
                registering={phase === 'registering'}
                onRegister={registerAsp}
            />
        {/if}

        <DepositCard
            bind:amount={depositAmountXlm}
            bind:blinding={membershipBlinding}
            {busy}
            depositing={phase === 'depositing'}
            {lastDepositHash}
            onDeposit={deposit}
        />

        <AskNurseCard bind:question {busy} asking={phase === 'asking'} onAsk={askNurse} />

        <div class="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            Each consult is an in-pool transfer (Groth16 proof + nullifier/commitment events); no
            XLM leaves the pool. The nurse's balance lives in encrypted notes only she can read —
            open this page in a second window with the nurse's Freighter wallet to watch her side.
        </div>

        <FlowSteps steps={flowSteps} />

        <AdviceCard {advice} />
    {/if}
</div>
