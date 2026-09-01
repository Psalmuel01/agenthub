# Named wallets

One file per wallet, so several can run at once without editing `.env` and
without putting a mnemonic on the command line — where it would be recorded in
shell history and visible in the process list to anyone on the machine.

    wallets/alice.txt      ->  --wallet=alice

Each file holds just the mnemonic: a 25-word Algorand phrase or a 24-word
BIP-39 one. Blank lines and lines starting with `#` are ignored, so a note about
which wallet it is can live alongside the phrase.

    # funding wallet, topped up 2026-08-30
    word1 word2 word3 ... word25

Everything in this directory except this README is gitignored. These are live
keys: anyone who reads one can spend that wallet.

## Running several at once

    # terminal 1
    npm run run-exhaust -- --wallet=alice

    # terminal 2
    npm run run-exhaust -- --wallet=bob

Different wallets in parallel is safe — they share no on-chain state. Two runs
against the *same* wallet is not: the second builds a payment before the first
has settled, and the server answers 402.

`npm run wallets` lists the names available.
