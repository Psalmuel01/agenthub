import "dotenv/config";
import { resolveAccount } from "./scripts/mnemonic";
const TARGET = "76CAH6WPMQDJ42CHR6QI7UJ77R4O3T4RANBQNHFEC457CEN6HE6OIDOBPI";
(async () => {
  const a = await resolveAccount(process.env.AVM_CLIENT_MNEMONIC ?? "", true);
  console.log("matches Pera:", a.addr === TARGET);
})();
