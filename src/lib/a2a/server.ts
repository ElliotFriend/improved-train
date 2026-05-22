import { Networks, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';
import { StrKey } from '@stellar/stellar-sdk';
import {
    A2A_NURSE_PUBLIC,
    A2A_NETWORK,
    A2A_AMOUNT_STROOPS,
    A2A_POOL_CONTRACT_ID,
    A2A_ASP_MEMBERSHIP_ID,
    A2A_ASP_NON_MEMBERSHIP_ID,
} from '$env/static/private';

export const config = {
    nursePublic: A2A_NURSE_PUBLIC,
    network: A2A_NETWORK,
    amountStroops: A2A_AMOUNT_STROOPS,
    poolContractId: A2A_POOL_CONTRACT_ID,
    aspMembershipId: A2A_ASP_MEMBERSHIP_ID,
    aspNonMembershipId: A2A_ASP_NON_MEMBERSHIP_ID,
};

const NETWORK_PASSPHRASE = config.network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

const sorobanRpc = new rpc.Server(
    config.network === 'testnet'
        ? 'https://soroban-testnet.stellar.org'
        : 'https://soroban.stellar.org',
);

/**
 * Verifies a patient-submitted `transact()` invocation against the spp pool:
 *   - RPC reports the tx SUCCESS
 *   - it's an InvokeHostFunction op targeting our pool contract
 *
 * The ZK proof + on-chain verifier already enforce the contract semantics
 * (recipient + amount + ASP roots), so a successful pool transact suffices —
 * we don't need to decode ExtData on the server.
 */
export async function verifyPayment(
    hash: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        const deadline = Date.now() + 10_000;
        let result = await sorobanRpc.getTransaction(hash);
        while (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 750));
            result = await sorobanRpc.getTransaction(hash);
        }
        if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
            return { ok: false, reason: 'tx not found on RPC within 10s' };
        }
        if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
            return { ok: false, reason: `tx status: ${result.status}` };
        }

        const tx = TransactionBuilder.fromXDR(result.envelopeXdr, NETWORK_PASSPHRASE);
        const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
        if (inner.operations.length !== 1) {
            return { ok: false, reason: `expected 1 op, got ${inner.operations.length}` };
        }
        const op = inner.operations[0];
        if (op.type !== 'invokeHostFunction') {
            return { ok: false, reason: `op type ${op.type}, expected invokeHostFunction` };
        }
        // Decode the host function args to confirm the contract address.
        const targeted = extractContractId(op.func);
        if (targeted !== config.poolContractId) {
            return {
                ok: false,
                reason: `tx targets ${targeted}, expected pool ${config.poolContractId}`,
            };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
}

function extractContractId(hostFunc: xdr.HostFunction): string | null {
    if (hostFunc.switch().name !== 'hostFunctionTypeInvokeContract') return null;
    const contractAddr = hostFunc.invokeContract().contractAddress();
    if (contractAddr.switch().name !== 'scAddressTypeContract') return null;
    return StrKey.encodeContract(Buffer.from(contractAddr.contractId() as unknown as Uint8Array));
}
