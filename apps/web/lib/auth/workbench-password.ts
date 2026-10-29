import { compare } from "bcryptjs";
import { verifyPassword } from "better-auth/crypto";

// Only the server-side requirement-pool synchronizer writes this namespace.
// New Workbench passwords keep Better Auth's native scrypt format.
const importedPrefix = "apitable-bcrypt:";

export async function verifyWorkbenchPassword({ hash, password }: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (hash.startsWith(importedPrefix)) {
    const encoded = hash.slice(importedPrefix.length);
    if (!/^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.test(encoded)
      || new TextEncoder().encode(password).length > 72) return false;
    return compare(password, encoded);
  }
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  try {
    return await verifyPassword({ hash, password });
  } catch {
    return false;
  }
}
