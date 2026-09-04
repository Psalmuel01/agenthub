import assert from "node:assert/strict";
import test from "node:test";
import { validatePaidRequestShape } from "../src/request-validation";

const address = "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4";
const txid = "B".repeat(52);

test("every paid route catches cheap malformed input", () => {
  assert.match(validatePaidRequestShape("POST", "/api/inference", { prompt: "" }, {})!, /prompt/);
  assert.match(validatePaidRequestShape("POST", "/api/summarize", { text: "ok", maxWords: 2 }, {})!, /maxWords/);
  assert.match(validatePaidRequestShape("GET", "/api/trace/not-an-address", {}, {})!, /address/);
  assert.match(validatePaidRequestShape("POST", "/api/verify-payment", { txid }, {})!, /at least one/);
});

test("valid request shapes pass pre-payment validation", () => {
  assert.equal(validatePaidRequestShape("GET", `/api/wallet-risk/${address}`, {}, {}), null);
  assert.equal(validatePaidRequestShape("POST", "/api/verify-payment", { txid, expectedAmount: 1 }, {}), null);
  assert.equal(validatePaidRequestShape("POST", "/api/nl-to-sql", { question: "q", schema: "t(id)" }, {}), null);
});

test("address checks include the Algorand checksum", () => {
  assert.match(validatePaidRequestShape("GET", `/api/wallet-risk/${"A".repeat(58)}`, {}, {})!, /address/);
});

test("payment amount and tolerance cannot be zero-negative or non-finite", () => {
  assert.match(validatePaidRequestShape("POST", "/api/verify-payment", { txid, expectedAmount: 0 }, {})!, /positive/);
  assert.match(validatePaidRequestShape("POST", "/api/verify-payment", { txid, expectedAmount: 1, amountTolerance: -1 }, {})!, /non-negative/);
});
