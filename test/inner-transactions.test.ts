import assert from "node:assert/strict";
import test from "node:test";
import { collectTransfers } from "../src/services/chain";

test("transfer collection walks nested inner transactions", async () => {
  const txn = {
    sender: "APP_CALLER",
    "inner-txns": [{
      sender: "APP_ADDRESS",
      "payment-transaction": { receiver: "RECIPIENT", amount: 2_500_000 },
      "inner-txns": [{
        sender: "RECIPIENT",
        "payment-transaction": { receiver: "CHANGE", amount: 500_000 },
      }],
    }],
  };
  const transfers = await collectTransfers(txn);
  assert.deepEqual(transfers.map((t) => [t.from, t.to, t.amountRaw]), [
    ["APP_ADDRESS", "RECIPIENT", "2500000"],
    ["RECIPIENT", "CHANGE", "500000"],
  ]);
});
