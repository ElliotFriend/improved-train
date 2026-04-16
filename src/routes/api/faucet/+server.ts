import type { RequestHandler } from './$types';
import { Asset, Operation } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { error, json } from '@sveltejs/kit';

import { makeTrustlineTransaction } from '$lib/utils/stellar/transactions';
// GDJQAGGLIF7JD4ZGS34VZKD7OEPTBMD6GTKK7GN36RYKARQHCPFPNBQW
// SDHUQ4Y6VWWWLEH2T5WWRULDGWJJIPXNIZBR6BSDTOAQLPURNMKC7Y3C

export const POST: RequestHandler = async ({ request, url }) => {
    const step = url.searchParams.get('step');
    if (!step || (step !== 'friendbot' && step !== 'trustline')) {
        error(400, { message: 'invalid faucet step' });
    }

    const { publicKey }: { publicKey: string } = await request.json();
    const server = new Server('https://soroban-testnet.stellar.org');

    if (step === 'friendbot') {
        try {
            // we have to create the account with friendbot
            const response = await server.fundAddress(publicKey);

            // return that it was successful, including the tx hash
            return json({
                success: true,
                hash: response.txHash,
            });
        } catch (err: unknown) {
            console.error(`Error funding account ${publicKey}. Error:`, JSON.stringify(err));
            error(500, { message: `Error funding account ${publicKey}` });
        }
    } else {
        try {
            const usdcAsset = new Asset(
                'USDC',
                'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            );

            // build a trustline transaction
            const builder = await makeTrustlineTransaction(publicKey, usdcAsset, server);

            // add a path payment to the transaction, so the user gets some USDC
            builder.addOperation(
                Operation.pathPaymentStrictReceive({
                    sendAsset: Asset.native(),
                    sendMax: '10', // this is probably (hopefully?) way overkill
                    destination: publicKey,
                    destAsset: usdcAsset,
                    destAmount: '5',
                }),
            );

            // return the transaction for signing
            return json({
                success: true,
                txXdr: builder.build().toXDR(),
            });
        } catch (err: unknown) {
            console.error(
                `Error creating trustline transaction for ${publicKey}. Error:`,
                JSON.stringify(err),
            );
            error(500, { message: `Error creating trustline for ${publicKey}` });
        }
    }
};
