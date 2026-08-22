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
 *   24 words — BIP-39, what Pera and Defly create for new wallets. The phrase
 *              is a *seed*; the key is derived from it. The phrase alone is
 *              not the key.
 *
 * A 24-word phrase is NOT a 25-word phrase with the checksum word removed, and
 * algosdk rejects it outright ("failed to decode mnemonic").
 *
 * THE DERIVATION IS ARC-52, NOT SLIP-0010. This matters and is easy to get
 * wrong. Most chains derive ed25519 keys with SLIP-0010; Algorand wallets do
 * not. They use BIP32-Ed25519 (Khovratovich-Law), standardised for Algorand as
 * ARC-52, which is a genuinely different algorithm — not merely a different
 * path. Deriving a Pera phrase with SLIP-0010 yields a valid-looking address
 * that the wallet has never heard of, at any path.
 *
 * Verified against a real Pera-generated wallet: the same 24 words produce the
 * wallet's actual address at m/44'/283'/0'/0/0 with g=9, and no SLIP-0010
 * derivation reproduces it (4,806 path/passphrase combinations were tried).
 *
 * g=9 is Algorand-specific. The BIP32-Ed25519 paper's standard derivations use
 * g=32; Algorand wallets zero 9 bits instead, so g=32 also misses.
 */
import algosdk from "algosdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** Hardened-index offset: level values at or above this are hardened. */
const HARDENED = 0x8000_0000;

/**
 * Algorand's ARC-52 account path: m / 44' / 283' / account' / change / index.
 * 283 is Algorand's SLIP-0044 coin type. Only the first three are hardened.
 */
const DEFAULT_PATH = "m/44'/283'/0'/0/0";

/** Bits zeroed during child derivation. Algorand uses 9, not the paper's 32. */
const ALGORAND_G = 9;

export interface ResolvedAccount {
  addr: string;
  /** 64-byte ed25519 secret key (seed || public key), as algosdk expects. */
  sk: Uint8Array;
  /** Which format the phrase turned out to be. */
  source: "algorand-25" | "bip39-24";
}

/** Normalise whitespace/case so pasted phrases still work. */
function normalise(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Parse "m/44'/283'/0'/0/0" into numeric levels, applying the hardened offset
 * to any segment marked with a trailing apostrophe.
 */
function parsePath(path: string): number[] {
  return path
    .split("/")
    .slice(1)
    .filter(Boolean)
    .map((segment) => {
      const hardened = segment.endsWith("'") || segment.endsWith("h");
      const value = parseInt(segment.replace(/['h]$/, ""), 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`invalid derivation path segment '${segment}' in '${path}'`);
      }
      return (hardened ? value + HARDENED : value) >>> 0;
    });
}

/**
 * Derive an Algorand keypair from a BIP-39 seed using ARC-52.
 *
 * The libraries involved are ESM-only and initialise asynchronously (libsodium
 * compiles a WASM module), so this is imported lazily and the whole function is
 * async. Callers that only handle 25-word phrases never pay that cost.
 */
async function deriveArc52(
  seed: Buffer,
  path: string,
): Promise<{ sk: Uint8Array; addr: string }> {
  const bip32 = await import("@algorandfoundation/xhd-wallet-api/dist/bip32-ed25519.js");

  // libsodium-wrappers-sumo must be >= 0.8: the 0.7.x ESM build imports a
  // sibling file that ships in a different package, so xhd-wallet-api (pure
  // ESM) fails to load with ERR_MODULE_NOT_FOUND. package.json pins 0.8.x.
  const sodiumModule = await import("libsodium-wrappers-sumo");
  const sodium: any = (sodiumModule as any).default ?? sodiumModule;
  await sodium.ready;

  let node: Uint8Array = bip32.fromSeed(seed);
  for (const level of parsePath(path)) {
    node = await bip32.deriveChildNodePrivate(node, level, ALGORAND_G);
  }

  // The derived scalar is already clamped, so the public key comes from a
  // no-clamp scalar multiplication rather than the usual keypair helper.
  const scalar = node.subarray(0, 32);
  const publicKey: Uint8Array = sodium.crypto_scalarmult_ed25519_base_noclamp(scalar);

  return {
    sk: new Uint8Array(Buffer.concat([Buffer.from(scalar), Buffer.from(publicKey)])),
    addr: algosdk.encodeAddress(new Uint8Array(publicKey)),
  };
}

/**
 * Accepts a 25-word Algorand mnemonic or a 24-word BIP-39 phrase.
 *
 * `announce` prints the derived address for BIP-39 input, so a mismatch with
 * the user's wallet is visible before any funds move.
 */
export async function resolveAccount(
  phrase: string,
  announce = true,
): Promise<ResolvedAccount> {
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
    const seed = Buffer.from(mnemonicToSeedSync(cleaned));
    const { sk, addr } = await deriveArc52(seed, path);

    if (announce) {
      console.log(`Derived from 24-word phrase (ARC-52, ${path}):`);
      console.log(`  ${addr}\n`);
    }
    return { addr, sk, source: "bip39-24" };
  }

  throw new Error(
    `expected a 25-word Algorand mnemonic or a 24-word BIP-39 phrase, got ${words.length} words`,
  );
}
