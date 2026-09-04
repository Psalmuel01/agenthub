import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS } from "../src/landing";
import { AgentHub } from "../packages/agenthub-algo/src/client";
import { TOOL_DEFINITIONS } from "../packages/agenthub-algo/src/tools";
import { buildCatalog } from "../src/catalog";

test("public catalog and SDK expose all 15 tools", () => {
  assert.equal(TOOLS.length, 15);
  assert.equal(TOOL_DEFINITIONS.length, 15);
  const methods = [
    "walletRisk", "explainTx", "verifyPayment", "assetRisk", "assetInfo", "portfolio",
    "relationship", "codeReview", "nlToSql", "inference", "summarize", "trace",
    "cluster", "appInfo", "appRisk",
  ];
  for (const method of methods) assert.equal(typeof (AgentHub.prototype as any)[method], "function", method);
  assert.equal(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size, 15);
});

test("server catalog prices match the release contract", async () => {
  process.env.RECEIVER_ADDRESS ||= "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4";
  process.env.FACILITATOR_URL ||= "https://facilitator.example";
  const { routes } = await import("../src/server");
  const prices = Object.fromEntries(buildCatalog(routes as any, TOOLS).map((e) => [e.name, e.priceUsd]));
  assert.deepEqual(prices, {
    inference: 0.05, summarize: 0.10, "nl-to-sql": 0.08, "code-review": 0.15,
    "verify-payment": 0.06, "asset-risk": 0.10, relationship: 0.10, asset: 0.05,
    "explain-tx": 0.08, "wallet-risk": 0.10, trace: 0.15, cluster: 0.20,
    app: 0.10, "app-risk": 0.18, portfolio: 0,
  });
});
