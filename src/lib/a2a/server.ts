import {
    Asset,
    Horizon,
    Keypair,
    Memo,
    Networks,
    Operation,
    TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
    A2A_PATIENT_SECRET,
    A2A_PATIENT_PUBLIC,
    A2A_NURSE_PUBLIC,
    A2A_AMOUNT_XLM,
} from '$env/static/private';

export const config = {
    patientSecret: A2A_PATIENT_SECRET,
    patientPublic: A2A_PATIENT_PUBLIC,
    nursePublic: A2A_NURSE_PUBLIC,
    amountXlm: A2A_AMOUNT_XLM,
};

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

export interface PaymentStep {
    label: string;
    detail?: string;
    durationMs: number;
}

/** Patient agent pays the nurse: native XLM payment on Stellar testnet. */
export async function submitPayment(): Promise<{ hash: string; ledger: number }> {
    const patient = Keypair.fromSecret(config.patientSecret);
    const account = await horizon.loadAccount(patient.publicKey());

    const tx = new TransactionBuilder(account, {
        fee: '10000',
        networkPassphrase: Networks.TESTNET,
    })
        .addOperation(
            Operation.payment({
                destination: config.nursePublic,
                asset: Asset.native(),
                amount: config.amountXlm,
            }),
        )
        .addMemo(Memo.text('a2a-consult'))
        .setTimeout(60)
        .build();

    tx.sign(patient);
    const res = await horizon.submitTransaction(tx);
    return { hash: res.hash, ledger: res.ledger };
}

/** Confirms a settlement tx on Horizon: successful, patient -> nurse, native, expected amount. */
export async function verifyPayment(
    hash: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        const tx = await horizon.transactions().transaction(hash).call();
        if (!tx.successful) return { ok: false, reason: 'tx not successful' };
        const ops = await horizon.operations().forTransaction(hash).call();
        const op = ops.records.find((r) => r.type === 'payment') as
            | (Horizon.ServerApi.PaymentOperationRecord & { from: string; to: string })
            | undefined;
        if (!op) return { ok: false, reason: 'no payment op' };
        if (op.from !== config.patientPublic) return { ok: false, reason: 'wrong from' };
        if (op.to !== config.nursePublic) return { ok: false, reason: 'wrong to' };
        if (op.asset_type !== 'native') return { ok: false, reason: 'wrong asset' };
        const paid = Number(op.amount);
        const want = Number(config.amountXlm);
        if (Math.abs(paid - want) > 1e-9) return { ok: false, reason: `wrong amount (${paid})` };
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
}

export const protocolSteps: PaymentStep[] = [
    { label: 'Loading patient agent wallet', durationMs: 150 },
    { label: 'Fetching nurse account sequence from Horizon', durationMs: 300 },
    { label: 'Constructing payment operation', detail: `${config.amountXlm} XLM`, durationMs: 200 },
    { label: 'Signing transaction (ed25519)', durationMs: 250 },
];
