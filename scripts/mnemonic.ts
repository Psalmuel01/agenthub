/**
 * Resolve a wallet mnemonic to an Algorand account, accepting both formats.
 *
 * TWO DIFFERENT STANDARDS share the word "mnemonic", and they are not
 * interchangeable:
 *
 *   25 words — Algorand's native format (algosdk). 24 words encoding the
 *              32-byte private key plus a final checksum word. The key IS the
 *              phrase; no derivation happens.
 *
 *   24 words — BIP-39, the cross-chain standard most current wallets (Pera,
 *              Defly) export. The phrase is a *seed*, from which a key is
 *              derived along a path. The phrase alone is not the key.
 *
 * A 24-word BIP-39 phrase is therefore NOT a truncated Algorand mnemonic, and
 * algosdk rejects it outright ("failed to decode mnemonic"). Supporting it means
 * doing the BIP-39 -> seed -> SLIP-0010 ed25519 derivation ourselves.
 *
 * DERIVATION PATH CAVEAT. We derive at m/44'/283'/0'/0'/0' (283 = Algorand's
 * SLIP-0044 coin type), which is the path Pera and Defly use for the first
 * account. The SLIP-0010 implementation here is verified against the official
 * test vector, but the *path* is a convention, not something we can prove from
 * a spec. A wallet using a different path yields a different, valid-looking
 * address that simply holds no funds.
 *
 * That failure is silent and expensive, so resolveAccount() prints the derived
 * address whenever it derives one. Check it against your wallet before funding.
 * If it does not match, set ALGO_DERIVATION_PATH or use the 25-word phrase —
 * every Algorand wallet can still export one.
 */
import crypto from "crypto";
import algosdk from "algosdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** Algorand's SLIP-0044 coin type; first account, first address. */
const DEFAULT_PATH = "m/44'/283'/0'/0'/0'";

export interface ResolvedAccount {
  addr: string;
  /** 64-byte ed25519 secret key (seed || public key), as algosdk expects. */
  sk: Uint8Array;
  /** Which format the phrase turned out to be. */
  source: "algorand-25" | "bip39-24";
}

/**
 * SLIP-0010 ed25519 derivation.
 *
 * ed25519 has no public-key arithmetic, so every level is hardened whether or
 * not the path says so — "0" and "0'" derive identically. Verified against
 * SLIP-0010 test vector 1 (seed 000102..0f, m/0').
 */
function deriveEd25519(seed: Buffer, path: string): Buffer {
  let digest = crypto
    .createHmac("sha512", Buffer.from("ed25519 seed"))
    .update(seed)
    .digest();
  let key = digest.subarray(0, 32);
  let chain = digest.subarray(32);

  for (const segment of path.split("/").slice(1)) {
    const index = (parseInt(segment, 10) | 0x8000_0000) >>> 0;
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32BE(index);

    digest = crypto
      .createHmac("sha512", chain)
      .update(Buffer.concat([Buffer.alloc(1, 0), key, indexBytes]))
      .digest();
    key = digest.subarray(0, 32);
    chain = digest.subarray(32);
  }
  return key;
}

/** Expand a 32-byte ed25519 seed into the 64-byte key algosdk signs with. */
function expandKey(privateSeed: Buffer): { sk: Uint8Array; publicKey: Buffer } {
  // Node has no raw ed25519 import, so wrap the seed in a minimal PKCS#8 header.
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    privateSeed,
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);

  return { sk: new Uint8Array(Buffer.concat([privateSeed, publicKey])), publicKey };
}

/** Normalise whitespace so pasted phrases with newlines or padding still work. */
function normalise(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Accepts a 25-word Algorand mnemonic or a 24-word BIP-39 phrase.
 *
 * `announce` prints the derived address for BIP-39 input — see the path caveat
 * in the file header. Pass false in tests or when the caller prints it itself.
 */
export function resolveAccount(phrase: string, announce = true): ResolvedAccount {
  const cleaned = normalise(phrase ?? "");
  if (!cleaned) {
    throw new Error("mnemonic is empty");
  }

  const words = cleaned.split(" ");

  if (words.length === 25) {
    const { sk, addr } = algosdk.mnemonicToSecretKey(cleaned);
    return { addr: String(addr), sk, source: "algorand-25" };
  }

  if (words.length === 24) {
    if (!validateMnemonic(cleaned, wordlist)) {
      throw new Error(
        "24-word phrase failed BIP-39 checksum validation — check for typos or " +
          "a word that is not in the BIP-39 English wordlist",
      );
    }

    const path = process.env.ALGO_DERIVATION_PATH || DEFAULT_PATH;
    const seed = mnemonicToSeedSync(cleaned);
    const { sk, publicKey } = expandKey(deriveEd25519(Buffer.from(seed), path));
    const addr = algosdk.encodeAddress(new Uint8Array(publicKey));

    if (announce) {
      console.log(`Derived from 24-word BIP-39 phrase at ${path}:`);
      console.log(`  ${addr}`);
      console.log("  ^ confirm this matches your wallet before funding it.\n");
    }
    return { addr, sk, source: "bip39-24" };
  }

  throw new Error(
    `expected a 25-word Algorand mnemonic or a 24-word BIP-39 phrase, got ${words.length} words`,
  );
}
