/**
 * Playwright lifecycle + typed wrappers around the prover page's window
 * functions. The page (public/prover.html) is the WASM access layer; this
 * module drives it from Node.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { startStaticServer } from './server.js';
import type { Server } from 'node:http';

export interface MarshalledProof {
    [k: string]: unknown;
}

export interface UserNote {
    id: string;
    amount: string;
    leafIndex: number;
    createdAtLedger: number;
    spent: boolean;
}

export interface UserKeys {
    noteKeypair: { private: string; public: string };
    encryptionKeypair: { private: string; public: string };
}

export interface KeyMessages {
    spending: string;
    encryption: string;
}

/** Revive {__bytes:[...]} → Uint8Array and {__bigint:"…"} → bigint, deeply. */
export function unmarshal(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.__bytes)) return Uint8Array.from(obj.__bytes as number[]);
    if (typeof obj.__bigint === 'string') return BigInt(obj.__bigint);
    if (Array.isArray(value)) return value.map(unmarshal);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = unmarshal(obj[k]);
    return out;
}

export class ProverBrowser {
    private server: Server | null = null;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private initialized = false;

    constructor(private readonly rpcUrl: string) {}

    async start(): Promise<void> {
        const { server, port } = await startStaticServer();
        this.server = server;
        const origin = `http://127.0.0.1:${port}`;

        this.browser = await chromium.launch({ headless: true, args: ['--headless=new'] });
        const context = await this.browser.newContext();
        this.page = await context.newPage();
        this.page.on('console', (msg) => {
            const t = msg.text();
            // Surface prover progress + errors; mute the verbose %c-styled logs.
            if (msg.type() === 'error' || t.startsWith('[prove]')) {
                console.error(`[page] ${t}`);
            }
        });
        this.page.on('pageerror', (err) => console.error(`[page:error] ${err.message}`));

        await this.page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30_000 });
        await this.page.waitForFunction(
            () => (window as unknown as { __sppReady?: boolean }).__sppReady,
            { timeout: 10_000 },
        );
        await this.page.evaluate(async (rpcUrl) => {
            const w = window as unknown as { __sppInit: (u: string) => Promise<unknown> };
            return w.__sppInit(rpcUrl);
        }, this.rpcUrl);
        this.initialized = true;
    }

    private p(): Page {
        if (!this.page || !this.initialized) throw new Error('ProverBrowser not started');
        return this.page;
    }

    async contractConfig(): Promise<{
        pool: string;
        asp_membership: string;
        asp_non_membership: string;
        verifier: string;
    }> {
        return this.p().evaluate(async () => {
            const w = window as unknown as {
                __sppContractConfig: () => Promise<{
                    pool: string;
                    asp_membership: string;
                    asp_non_membership: string;
                    verifier: string;
                }>;
            };
            return w.__sppContractConfig();
        });
    }

    async keyMessages(): Promise<KeyMessages> {
        return this.p().evaluate(async () => {
            const w = window as unknown as { __sppKeyMessages: () => Promise<KeyMessages> };
            return w.__sppKeyMessages();
        });
    }

    async deriveKeys(address: string, spendingSigB64: string, encryptionSigB64: string): Promise<void> {
        await this.p().evaluate(
            async ([address, s, e]) => {
                const w = window as unknown as {
                    __sppDeriveKeys: (a: string, s: string, e: string) => Promise<unknown>;
                };
                return w.__sppDeriveKeys(address, s, e);
            },
            [address, spendingSigB64, encryptionSigB64] as const,
        );
    }

    async getUserKeys(address: string): Promise<UserKeys | null> {
        return this.p().evaluate(async (address) => {
            const w = window as unknown as {
                __sppGetUserKeys: (a: string) => Promise<UserKeys | null>;
            };
            return w.__sppGetUserKeys(address);
        }, address);
    }

    async getUserNotes(address: string, limit: number): Promise<UserNote[]> {
        const notes = await this.p().evaluate(
            async ([address, limit]) => {
                const w = window as unknown as {
                    __sppGetUserNotes: (a: string, l: number) => Promise<UserNote[] | null>;
                };
                return w.__sppGetUserNotes(address, limit as number);
            },
            [address, limit] as const,
        );
        return notes ?? [];
    }

    async deriveAspLeaf(blinding: bigint, pubkeyHex: string): Promise<string> {
        return this.p().evaluate(
            async ([b, pk]) => {
                const w = window as unknown as {
                    __sppDeriveAspLeaf: (b: string, pk: string) => Promise<string>;
                };
                return w.__sppDeriveAspLeaf(b, pk);
            },
            [blinding.toString(), pubkeyHex] as const,
        );
    }

    async proveDeposit(
        address: string,
        blinding: bigint,
        amountStroops: bigint,
        outputs: bigint[],
    ): Promise<MarshalledProof | null> {
        const raw = await this.p().evaluate(
            async ([address, blinding, amount, outputs]) => {
                const w = window as unknown as {
                    __sppProveDeposit: (
                        a: string,
                        b: string,
                        amt: string,
                        o: string[],
                    ) => Promise<unknown>;
                };
                return w.__sppProveDeposit(
                    address as string,
                    blinding as string,
                    amount as string,
                    outputs as string[],
                );
            },
            [address, blinding.toString(), amountStroops.toString(), outputs.map((o) => o.toString())] as const,
        );
        return raw == null ? null : (unmarshal(raw) as MarshalledProof);
    }

    async proveTransact(args: {
        address: string;
        blinding: bigint;
        extRecipient: string;
        extAmount: bigint;
        inputNoteIds: string[];
        outputs: bigint[];
        outNoteKeysHex: string[];
        outEncKeysHex: string[];
    }): Promise<MarshalledProof | null> {
        const raw = await this.p().evaluate(
            async (a) => {
                const w = window as unknown as {
                    __sppProveTransact: (
                        address: string,
                        blinding: string,
                        extRecipient: string,
                        extAmount: string,
                        inputNoteIds: string[],
                        outputs: string[],
                        outNoteKeysHex: string[],
                        outEncKeysHex: string[],
                    ) => Promise<unknown>;
                };
                return w.__sppProveTransact(
                    a.address,
                    a.blinding,
                    a.extRecipient,
                    a.extAmount,
                    a.inputNoteIds,
                    a.outputs,
                    a.outNoteKeysHex,
                    a.outEncKeysHex,
                );
            },
            {
                address: args.address,
                blinding: args.blinding.toString(),
                extRecipient: args.extRecipient,
                extAmount: args.extAmount.toString(),
                inputNoteIds: args.inputNoteIds,
                outputs: args.outputs.map((o) => o.toString()),
                outNoteKeysHex: args.outNoteKeysHex,
                outEncKeysHex: args.outEncKeysHex,
            },
        );
        return raw == null ? null : (unmarshal(raw) as MarshalledProof);
    }

    async stop(): Promise<void> {
        if (this.browser) await this.browser.close();
        if (this.server) this.server.close();
        this.browser = null;
        this.page = null;
        this.server = null;
        this.initialized = false;
    }
}
