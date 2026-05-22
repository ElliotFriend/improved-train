// Shared types for the Nethermind stellar-private-payments WASM bundle.

export interface ContractConfig {
    pool: string;
    asp_membership: string;
    asp_non_membership: string;
    verifier: string;
}

export interface UserNote {
    id: string;
    amount: string;
}

export interface UserKeys {
    noteKeypair: { private: string; public: string };
    encryptionKeypair: { private: string; public: string };
}

export interface ProveStatus {
    stage?: string;
    message?: string;
    current?: number;
    total?: number;
    flow?: string;
}

export type ProveStatusCallback = (p: ProveStatus) => void;

/**
 * The subset of the upstream `WebClient` wasm-bindgen surface we touch from
 * the SvelteKit app. See `app/crates/platforms/web/src/client.rs` for the
 * authoritative definitions; this interface is a hand-typed shim because the
 * vendored `static/spp/js/web.js` is not part of our module graph.
 */
export interface WebClient {
    contractConfig(): ContractConfig;
    spendingKeyMessage(): string;
    encryptionDerivationMessage(): string;
    getUserKeys(address: string): Promise<UserKeys | null>;
    deriveAndSaveUserKeys(
        address: string,
        spendingSig: Uint8Array,
        encryptionSig: Uint8Array,
    ): Promise<void>;
    getUserNotes(address: string, limit: number): Promise<UserNote[] | null>;
    deriveAspUserLeaf(membershipBlinding: bigint, pubkeyHex: string): Promise<string>;
    proveDeposit(
        address: string,
        membershipBlinding: bigint,
        amountStroops: bigint,
        outputAmounts: bigint[],
        onStatus?: ProveStatusCallback,
    ): Promise<Proved | null>;
    proveWithdraw(
        address: string,
        membershipBlinding: bigint,
        recipient: string,
        inputNoteIds: string[],
        onStatus?: ProveStatusCallback,
    ): Promise<Proved | null>;
}

export interface WasmHandle {
    webClient: WebClient;
}

/**
 * Output of `WebClient.proveDeposit` / `proveWithdraw`. The shape is dictated
 * by the upstream Rust prover and is treated as opaque here, save for the
 * fields `submitProvedPoolTransact` pulls out.
 */
export interface Proved {
    proofUncompressed?: Uint8Array | number[];
    proof_uncompressed?: Uint8Array | number[];
    extData?: ProvedExtData;
    ext_data?: ProvedExtData;
    prepared?: ProvedPrepared;
}

export interface ProvedExtData {
    recipient: string;
    ext_amount?: string | number | bigint;
    extAmount?: string | number | bigint;
    encrypted_output0?: Uint8Array | number[];
    encryptedOutput0?: Uint8Array | number[];
    encrypted_output1?: Uint8Array | number[];
    encryptedOutput1?: Uint8Array | number[];
}

export interface ProvedPrepared {
    poolRoot: string;
    inputNullifiers: [string, string];
    outputCommitments: [string, string];
    publicAmount: string;
    extDataHashBe: Uint8Array | number[];
    aspMembershipRoot: string;
    aspNonMembershipRoot: string;
}
