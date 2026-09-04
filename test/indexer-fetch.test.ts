import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonLossless } from "../src/services/indexer-fetch";

test("lossless JSON preserves unsafe uint64 values", () => {
  const value = parseJsonLossless('{"safe":42,"raw":18446744073709551615,"text":"18446744073709551615"}');
  assert.equal(value.safe, 42);
  assert.equal(value.raw, "18446744073709551615");
  assert.equal(value.text, "18446744073709551615");
});

test("lossless JSON rejects duplicate keys and prototype keys", () => {
  assert.throws(() => parseJsonLossless('{"a":1,"a":2}'));
  assert.throws(() => parseJsonLossless('{"__proto__":{"polluted":true}}'));
});
