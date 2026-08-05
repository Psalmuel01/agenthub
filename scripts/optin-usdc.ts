/**
 * One-off helper: opt an Algorand testnet account into USDC (ASA 10458941).
 *
 * An account must opt in to an ASA before it can hold or receive it. Both the
 * receiver (to get paid) and the payer (to send USDC) need this once.
 *
 * Usage:
 *   MNEMONIC="word1 ... word25" npm run optin-usdc
 *
 * Safe to re-run: if the account is already opted in, it exits without sending
 * a redundant transaction.
 */
import "dotenv/config";
import algosdk from "algosdk";

const USDC_TESTNET_ASA_ID = 10458941;
const ALGOD_URL = process.env.ALGOD_URL || "https://testnet-api.algonode.cloud";

async function main() {
  const mnemonic = (process.env.MNEMONIC || "").trim();
  if (!mnemonic || mnemonic.split(/\s+/).length !== 25) {
    throw new Error('Set MNEMONIC="<25 words>" for the account to opt in. Example:\n  MNEMONIC="a b c ... y" npm run optin-usdc');
  }

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const address = algosdk.encodeAddress(account.addr.publicKey);
  const algod = new algosdk.Algodv2("", ALGOD_URL, "");

  console.log(`Account : ${address}`);
  console.log(`Algod   : ${ALGOD_URL}`);

  // Already opted in?
  const info = await algod.accountInformation(address).do();
  const already = (info.assets || []).some((a: any) => Number(a.assetId ?? a["asset-id"]) === USDC_TESTNET_ASA_ID);
  if (already) {
    console.log("✅ Already opted into USDC (ASA 10458941) — nothing to do.");
    return;
  }

  // Opt-in = a 0-amount asset transfer to self.
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: USDC_TESTNET_ASA_ID,
    suggestedParams: sp,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  console.log(`→ submitted opt-in txn ${txid}, waiting for confirmation…`);
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`✅ Opted into USDC. Explorer: https://testnet.explorer.perawallet.app/tx/${txid}`);
}

main().catch((err) => {
  console.error("❌ Opt-in failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
