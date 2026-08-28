/**
 * Minimal example: use the published agenthub-algo package as a client.
 *
 * Runs the free portfolio() call, then a paid walletRisk() call — the 402
 * quote, USDC signing, and retry all happen inside the library.
 *
 * Requires in .env: AVM_CLIENT_MNEMONIC (a 25-word Algorand mnemonic — this
 * package's AgentHub class signs with algosdk directly and does not support
 * 24-word BIP-39/ARC-52 phrases the way scripts/mnemonic.ts does).
 *
 * Usage:
 *   npm run use-client -- <ALGORAND_ADDRESS>
 */
import "dotenv/config";
import { AgentHub, AgentHubError } from "agenthub-algo";

async function main() {
  const address = process.argv[2];
  if (!address) {
    throw new Error("usage: npm run use-client -- <ALGORAND_ADDRESS>");
  }

  const mnemonic = process.env.AVM_CLIENT_MNEMONIC;
  if (!mnemonic || mnemonic.includes("word1 word2") || mnemonic.startsWith("YOUR_")) {
    throw new Error("Set AVM_CLIENT_MNEMONIC in .env to a 25-word Algorand mnemonic before running this.");
  }

  const hub = new AgentHub({ mnemonic });

  console.log(`→ portfolio(${address})  [free]`);
  const holdings = await hub.portfolio(address);
  console.log(JSON.stringify(holdings, null, 2));

  console.log(`\n→ walletRisk(${address})  [$0.03, pays automatically]`);
  const risk = await hub.walletRisk(address);
  console.log(JSON.stringify(risk, null, 2));
}

main().catch((err) => {
  console.error("\n❌ use-client failed:");
  if (err instanceof AgentHubError) {
    console.error(`  [${err.status}] ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
