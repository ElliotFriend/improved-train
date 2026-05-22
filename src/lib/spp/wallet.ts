import {
    WatchWalletChanges,
    getAddress,
    getNetworkDetails,
    isAllowed,
    isConnected,
    requestAccess,
    setAllowed,
    signAuthEntry,
    signTransaction,
    signMessage,
} from '@stellar/freighter-api';

import { getHandle } from './wasm-facade.js';

interface FreighterError {
    message?: string;
    code?: string;
}

type WalletErrorCode = 'USER_REJECTED' | 'WALLET_ERROR';

class WalletError extends Error {
    code: WalletErrorCode;
    cause?: unknown;
    constructor(message: string, code: WalletErrorCode, cause?: unknown) {
        super(message);
        this.code = code;
        this.cause = cause;
    }
}

function normalizeWalletError(
    error: FreighterError | undefined,
    fallback = 'Wallet error',
): WalletError {
    const message = error?.message ?? fallback;
    const lower = message.toLowerCase();
    const code: WalletErrorCode = /reject|declin|denied|cancel/.test(lower)
        ? 'USER_REJECTED'
        : 'WALLET_ERROR';
    return new WalletError(message, code, error);
}

async function assertFreighterInstalled(): Promise<void> {
    const conn = await isConnected();
    if (conn?.error) throw normalizeWalletError(conn.error, 'Failed to check Freighter connection');
    if (!conn?.isConnected) {
        throw new Error('Freighter not detected. Install from https://www.freighter.app/');
    }
}

interface EnsureReadyOpts {
    requestAddress?: boolean;
}

async function ensureFreighterReady(
    opts: EnsureReadyOpts & { requestAddress: true },
): Promise<string>;
async function ensureFreighterReady(opts?: EnsureReadyOpts): Promise<void>;
async function ensureFreighterReady(opts: EnsureReadyOpts = {}): Promise<string | void> {
    await assertFreighterInstalled();

    const allowed = await isAllowed();
    if (allowed?.error)
        throw normalizeWalletError(allowed.error, 'Failed to check Freighter allow-list');

    if (!allowed?.isAllowed) {
        const set = await setAllowed();
        if (set?.error) throw normalizeWalletError(set.error, 'Freighter access rejected');
    }

    if (opts.requestAddress) {
        const access = await requestAccess();
        if (access?.error)
            throw normalizeWalletError(access.error, 'Freighter access request failed');
        if (!access?.address) throw new Error('No public key returned');
        return access.address;
    }
}

export async function connectWallet(): Promise<string> {
    return ensureFreighterReady({ requestAddress: true });
}

export async function getWalletAddress(): Promise<string> {
    await ensureFreighterReady();
    const res = await getAddress();
    if (res?.error) throw normalizeWalletError(res.error, 'Failed to get active Freighter address');
    if (!res?.address) throw new Error('No public key returned');
    return res.address;
}

export interface WalletWatchInfo {
    address?: string;
    network?: string;
    networkPassphrase?: string;
}

export interface StartWalletWatcherOpts {
    intervalMs?: number;
    onChange: (info: WalletWatchInfo) => void;
}

export function startWalletWatcher(opts: StartWalletWatcherOpts): () => void {
    const { intervalMs = 3000, onChange } = opts;
    const watcher = new WatchWalletChanges(intervalMs);
    const res = watcher.watch((info: WalletWatchInfo) => {
        try {
            onChange?.(info);
        } catch (e) {
            console.warn('[Wallet] watch callback failed:', e);
        }
    });
    if (res && typeof res === 'object' && 'error' in res && res.error) {
        throw normalizeWalletError(res.error as FreighterError, 'Failed to start wallet watcher');
    }
    return () => watcher.stop();
}

export interface WalletNetworkDetails {
    network: string;
    networkUrl: string;
    networkPassphrase: string;
    sorobanRpcUrl?: string;
}

export async function getWalletNetwork(): Promise<WalletNetworkDetails> {
    const details = await getNetworkDetails();
    if (details?.error)
        throw normalizeWalletError(details.error, 'Failed to get Freighter network details');
    const { network, networkUrl, networkPassphrase, sorobanRpcUrl } = details;
    return { network, networkUrl, networkPassphrase, sorobanRpcUrl };
}

export interface SignContextOpts {
    address?: string;
    networkPassphrase?: string;
}

export interface SignTxResult {
    signedTxXdr: string;
    signerAddress: string;
}

export async function signWalletTransaction(
    transactionXdr: string,
    opts: SignContextOpts = {},
): Promise<SignTxResult> {
    await ensureFreighterReady();
    const { signedTxXdr, signerAddress, error } = await signTransaction(transactionXdr, opts);
    if (error) throw normalizeWalletError(error, 'Transaction signature failed');
    return { signedTxXdr, signerAddress };
}

export interface SignAuthResult {
    signedAuthEntry: string | null;
    signerAddress: string;
}

export async function signWalletAuthEntry(
    entryXdr: string,
    opts: SignContextOpts = {},
): Promise<SignAuthResult> {
    await ensureFreighterReady();
    const { signedAuthEntry, signerAddress, error } = await signAuthEntry(entryXdr, opts);
    if (error) throw normalizeWalletError(error, 'Auth entry signature failed');
    return { signedAuthEntry, signerAddress };
}

interface SignMessageOpts extends SignContextOpts {
    skipEnsureReady?: boolean;
}

export interface SignMessageResult {
    signedMessage: string;
    signerAddress: string;
}

export async function signWalletMessage(
    message: string,
    opts: SignMessageOpts = {},
): Promise<SignMessageResult> {
    const { skipEnsureReady = false, ...freighterOpts } = opts;
    if (!skipEnsureReady) await ensureFreighterReady();

    const result = await signMessage(message, freighterOpts);
    const { signedMessage, signerAddress, error } = result || {};
    if (error) throw normalizeWalletError(error, 'Message signature failed');
    if (!signedMessage)
        throw new Error('No signature returned. User may have rejected the request.');
    // Freighter typings call this `string | Buffer`, but in the browser it is
    // always a base64 string.
    return { signedMessage: signedMessage as string, signerAddress };
}

export interface DeriveKeysOpts {
    onStatus?: (msg: string) => void;
    signOptions?: SignContextOpts;
    signDelay?: number;
    skipCacheCheck?: boolean;
}

export interface DerivedKeys {
    privKey: string;
    pubKey: string;
    encryptionKeypair: { publicKey: string; privateKey: string };
}

/**
 * Derives spending and encryption keys from Freighter wallet signatures.
 * Returns cached keys when present unless `skipCacheCheck` is set.
 */
export async function deriveKeysFromWallet(
    account: string,
    { onStatus, signOptions = {}, signDelay = 300, skipCacheCheck = false }: DeriveKeysOpts,
): Promise<DerivedKeys> {
    const client = getHandle().webClient;

    if (!skipCacheCheck) {
        const cached = await client.getUserKeys(account);
        if (cached) {
            onStatus?.('Loaded privacy keys from local storage');
            return {
                privKey: cached.noteKeypair.private,
                pubKey: cached.noteKeypair.public,
                encryptionKeypair: {
                    publicKey: cached.encryptionKeypair.public,
                    privateKey: cached.encryptionKeypair.private,
                },
            };
        }
    }

    onStatus?.('Signature 1/2: derive spending key (proves note ownership; does not move funds)…');
    let spendingResult: SignMessageResult;
    try {
        spendingResult = await signWalletMessage(client.spendingKeyMessage(), {
            ...signOptions,
            skipEnsureReady: true,
        });
    } catch (e) {
        if (e instanceof WalletError && e.code === 'USER_REJECTED') {
            throw new Error(
                'Please approve the message signature to derive your spending key',
                { cause: e },
            );
        }
        throw e;
    }

    if (signDelay > 0) await new Promise((r) => setTimeout(r, signDelay));

    onStatus?.(
        'Signature 2/2: derive encryption key (decrypts incoming notes; does not move funds)…',
    );
    let encryptionResult: SignMessageResult;
    try {
        encryptionResult = await signWalletMessage(client.encryptionDerivationMessage(), {
            ...signOptions,
            skipEnsureReady: true,
        });
    } catch (e) {
        if (e instanceof WalletError && e.code === 'USER_REJECTED') {
            throw new Error(
                'Please approve the message signature to derive your encryption key',
                { cause: e },
            );
        }
        throw e;
    }

    const spendingSigBytes = Uint8Array.from(atob(spendingResult.signedMessage), (c) =>
        c.charCodeAt(0),
    );
    const encryptionSigBytes = Uint8Array.from(atob(encryptionResult.signedMessage), (c) =>
        c.charCodeAt(0),
    );
    await client.deriveAndSaveUserKeys(account, spendingSigBytes, encryptionSigBytes);

    const data = await client.getUserKeys(account);
    if (!data) throw new Error('Failed to load freshly-derived user keys');
    return {
        privKey: data.noteKeypair.private,
        pubKey: data.noteKeypair.public,
        encryptionKeypair: {
            publicKey: data.encryptionKeypair.public,
            privateKey: data.encryptionKeypair.private,
        },
    };
}
