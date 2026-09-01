/**
 * Resolve a wallet mnemonic to a signer, accepting both Algorand phrase formats.
 *
 * TWO DIFFERENT STANDARDS share the word "mnemonic", and they are not
 * interchangeable:
 *
 *   25 words — Algorand's native format (algosdk). 24 words encoding the
 *              32-byte private key plus a final checksum word. The key IS the
 *              phrase; no derivation happens.
 *
 *   24 words — BIP-39, what Pera and Defly create for new wallets. The phrase
 *              is a *seed*; the key is derived from it.
 *
 * A 24-word phrase is NOT a 25-word phrase with the checksum word removed, and
 * algosdk rejects it outright ("failed to decode mnemonic").
 *
 * THE DERIVATION IS ARC-52, NOT SLIP-0010. Most chains derive ed25519 keys with
 * SLIP-0010; Algorand wallets do not. They use BIP32-Ed25519 (Khovratovich-Law)
 * with Peikert's g=9 variant, standardised for Algorand as ARC-52 — a different
 * algorithm, not merely a different path. Deriving a Pera phrase with SLIP-0010
 * produces a valid-looking address the wallet has never heard of, at any path.
 * Verified against a real Pera wallet: ARC-52 reproduces its address exactly,
 * and 4,806 SLIP-0010 path/passphrase combinations do not.
 *
 * SIGNING GOES THROUGH THE LIBRARY, DELIBERATELY. An ARC-52 key is a clamped
 * scalar rather than a seed, so neither algosdk's signTxn nor the x402 helper
 * toClientAvmSigner can sign with it — both assume a seed and silently derive a
 * different address. Hand-rolling the ed25519 nonce is worse: an earlier
 * attempt here produced signatures that verified locally against their own
 * public key but were rejected on chain ("At least one signature didn't pass
 * verification"). Local verification cannot catch that class of bug, so
 * signAlgoTransaction from the Foundation's own implementation does the work,
 * and correctness is confirmed against algod's simulate endpoint.
 */
import fs from "fs";
import path from "path";
import algosdk from "algosdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/**
 * ARC-52 addresses a key by (context, account, index) rather than a free-form
 * path; these correspond to m/44'/283'/<account>'/0/<index>. Overridable for
 * wallets holding funds on a later account or address index.
 */
const DEFAULT_ACCOUNT = Number(process.env.ALGO_ACCOUNT_INDEX ?? 0);
const DEFAULT_KEY_INDEX = Number(process.env.ALGO_ADDRESS_INDEX ?? 0);

export interface ResolvedAccount {
  addr: string;
  source: "algorand-25" | "bip39-24";
  /** 25-word only: the 64-byte key algosdk signs with. */
  sk?: Uint8Array;
  /** 24-word only: the 96-byte ARC-52 root key, plus where the account sits. */
  rootKey?: Uint8Array;
  account?: number;
  keyIndex?: number;
}

/** Minimal signer shape the x402 client requires. */
export interface ClientSigner {
  address: string;
  signTransactions(
    txns: Uint8Array[],
    indexesToSign?: number[],
  ): Promise<(Uint8Array | null)[]>;
}

/**
 * Directory holding one file per named wallet, e.g. wallets/alice.txt.
 *
 * Gitignored. Each file contains just the mnemonic — a 25-word Algorand phrase
 * or a 24-word BIP-39 one — with blank lines and #-comments ignored.
 */
const WALLET_DIR = "wallets";

/**
 * Resolve which mnemonic to use, by name or from the environment.
 *
 * Running several wallets at once used to mean editing .env between runs or
 * pasting phrases onto the command line, where they end up in shell history and
 * in the process list other users can read. A name keeps the secret in a
 * gitignored file and off both.
 *
 * Precedence: an explicit --wallet name, then AVM_CLIENT_MNEMONIC from the
 * environment (which a shell prefix can still override for one command), then
 * nothing.
 */
export function loadMnemonic(walletName?: string | null): string {
  if (walletName) {
    const safe = walletName.trim();
    // Names index a file, so anything path-like is refused rather than resolved:
    // --wallet=../../.env should not become a way to read arbitrary files.
    if (!/^[A-Za-z0-9._-]+$/.test(safe)) {
      throw new Error(
        `invalid wallet name "${walletName}" — use letters, digits, dot, dash or underscore`,
      );
    }

    const file = path.join(WALLET_DIR, safe.endsWith(".txt") ? safe : `${safe}.txt`);
    if (!fs.existsSync(file)) {
      const known = fs.existsSync(WALLET_DIR)
        ? fs.readdirSync(WALLET_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, ""))
        : [];
      throw new Error(
        `no wallet named "${safe}" (looked for ${file})` +
          (known.length ? `\nKnown wallets: ${known.join(", ")}` : `\nCreate ${file} containing the mnemonic.`),
      );
    }

    const phrase = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join(" ")
      .trim();

    if (!phrase) throw new Error(`${file} is empty`);
    return phrase;
  }

  const fromEnv = process.env.AVM_CLIENT_MNEMONIC;
  if (!fromEnv) {
    throw new Error(
      "no wallet selected: set AVM_CLIENT_MNEMONIC in .env, or pass --wallet=<name> " +
        `to use ${WALLET_DIR}/<name>.txt`,
    );
  }
  return fromEnv;
}

/** Read --wallet=<name> from argv, if present. */
export function walletArg(argv: string[] = process.argv): string | null {
  const arg = argv.find((a) => a.startsWith("--wallet="));
  return arg ? arg.slice("--wallet=".length) : null;
}

/** Normalise whitespace/case so pasted phrases still work. */
function normalise(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Load the Foundation's ARC-52 implementation. ESM-only, so imported lazily. */
async function loadXhd() {
  const crypto: any = await import(
    "@algorandfoundation/xhd-wallet-api/dist/x.hd.wallet.api.crypto.js"
  );
  const bip32: any = await import(
    "@algorandfoundation/xhd-wallet-api/dist/bip32-ed25519.js"
  );
  return { crypto, bip32 };
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

    const { crypto, bip32 } = await loadXhd();
    const seed = Buffer.from(mnemonicToSeedSync(cleaned));
    const rootKey: Uint8Array = bip32.fromSeed(seed);

    const api = new crypto.XHDWalletAPI();
    const publicKey = await api.keyGen(
      rootKey,
      crypto.KeyContext.Address,
      DEFAULT_ACCOUNT,
      DEFAULT_KEY_INDEX,
      crypto.BIP32DerivationType.Peikert,
    );
    const addr = algosdk.encodeAddress(new Uint8Array(publicKey));

    if (announce) {
      console.log(
        `Derived from 24-word phrase (ARC-52, account ${DEFAULT_ACCOUNT}, index ${DEFAULT_KEY_INDEX}):`,
      );
      console.log(`  ${addr}\n`);
    }
    return {
      addr,
      source: "bip39-24",
      rootKey,
      account: DEFAULT_ACCOUNT,
      keyIndex: DEFAULT_KEY_INDEX,
    };
  }

  throw new Error(
    `expected a 25-word Algorand mnemonic or a 24-word BIP-39 phrase, got ${words.length} words`,
  );
}

/**
 * Build an x402 ClientAvmSigner for a resolved account.
 *
 * Both branches sign locally and return msgpack-encoded SignedTransactions; the
 * 25-word path is algosdk's own signing, unchanged from before this file existed.
 */
export async function toSigner(account: ResolvedAccount): Promise<ClientSigner> {
  if (account.source === "algorand-25") {
    const sk = account.sk!;
    return {
      address: account.addr,
      async signTransactions(txns, indexesToSign) {
        const wanted = indexesToSign ?? txns.map((_, i) => i);
        return txns.map((txn, i) =>
          wanted.includes(i)
            ? algosdk.decodeUnsignedTransaction(txn).signTxn(sk)
            : null,
        );
      },
    };
  }

  const { crypto } = await loadXhd();
  const api = new crypto.XHDWalletAPI();
  const { rootKey, account: acct, keyIndex } = account;

  return {
    address: account.addr,
    async signTransactions(txns, indexesToSign) {
      const wanted = indexesToSign ?? txns.map((_, i) => i);
      const out: (Uint8Array | null)[] = [];

      for (let i = 0; i < txns.length; i++) {
        if (!wanted.includes(i)) {
          out.push(null);
          continue;
        }
        const txn = algosdk.decodeUnsignedTransaction(txns[i]);
        // bytesToSign() already carries the "TX" domain prefix — adding another
        // signs "TXTX..." and the network rejects the signature.
        const sig = await api.signAlgoTransaction(
          rootKey!,
          crypto.KeyContext.Address,
          acct!,
          keyIndex!,
          txn.bytesToSign(),
          crypto.BIP32DerivationType.Peikert,
        );
        out.push(
          algosdk.encodeMsgpack(
            new algosdk.SignedTransaction({ txn, sig: new Uint8Array(sig) }),
          ),
        );
      }
      return out;
    },
  };
}
