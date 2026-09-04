import assert from "node:assert/strict";
import test from "node:test";
import { onCompletionReferencesFromDisassembly } from "../src/services/app-info";

test("app analyser reports mode references, including intcblock constants", () => {
  const refs = onCompletionReferencesFromDisassembly(`
    intcblock 0 4 5
    txn OnCompletion
    intc_1
    ==
    bnz update
    txn OnCompletion
    intc 2
    ==
    bnz delete
  `);
  assert.deepEqual([...refs].sort(), [4, 5]);
});

test("mentioning a mode without comparing OnCompletion is not a finding", () => {
  assert.deepEqual([...onCompletionReferencesFromDisassembly("int 4\nreturn")], []);
});
