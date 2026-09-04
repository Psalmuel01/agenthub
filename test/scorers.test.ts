import assert from "node:assert/strict";
import test from "node:test";
import { scoreWalletSignals } from "../src/services/wallet-risk";
import { scoreAssetSignals } from "../src/services/asset-risk";

test("wallet scorer is deterministic and clamps at 100", () => {
  assert.deepEqual(scoreWalletSignals({ accountAgeDays: null, txCount: 0, balanceAlgo: 0, usdcOptedIn: false, distinctCounterparties: 0, rekeyed: true }), { riskScore: 100, riskLevel: "high" });
  assert.deepEqual(scoreWalletSignals({ accountAgeDays: 365, txCount: 100, balanceAlgo: 5, usdcOptedIn: true, distinctCounterparties: 10, rekeyed: false }), { riskScore: 0, riskLevel: "low" });
});

test("asset scorer applies documented risk signals", () => {
  const result = scoreAssetSignals({ clawbackEnabled: true, freezeEnabled: true, defaultFrozen: false, managerCanReconfigure: true, topHolderPct: 95, holdersSampled: 20, concentrationExact: false, creatorAgeDays: 2 });
  assert.deepEqual(result, { riskScore: 100, riskLevel: "high" });
});
