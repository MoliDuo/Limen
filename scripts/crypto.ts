import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  const envFile = ['.env.local', '.env'].find((candidate) =>
    existsSync(candidate),
  );
  if (envFile) process.loadEnvFile(envFile);
}

const USAGE = `Usage: npm run crypto -- <command>

  status               How many rows are still plaintext, how many key slots exist
  encrypt-existing     Encrypt every row written before encryption, in one go
  add-password         Let a new password open the data key as well
                       (reads it from NEW_AUTH_PASSWORD, or asks for it)
  remove-other-slots   Keep only the slot that AUTH_PASSWORD opens

DATABASE_URL and AUTH_PASSWORD come from the environment or .env.local.
See docs/encryption.md.`;

function requirePassword() {
  const password = process.env.AUTH_PASSWORD;
  if (!password) throw new Error('AUTH_PASSWORD is required');
  return password;
}

async function readNewPassword() {
  const fromEnv = process.env.NEW_AUTH_PASSWORD;
  if (fromEnv) return fromEnv;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const first = await rl.question('New password: ');
    const second = await rl.question('Repeat it: ');
    if (first !== second) throw new Error('The two passwords differ.');
    return first;
  } finally {
    rl.close();
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const [{ db }, slots, backfill] = await Promise.all([
    import('../src/lib/db/index'),
    import('../src/lib/crypto/key-slots'),
    import('../src/lib/crypto/backfill'),
  ]);

  switch (command) {
    case 'status': {
      const legacy = await backfill.countLegacyRows(db);
      console.log(`Key slots:           ${await slots.countKeySlots(db)}`);
      console.log(`Plaintext entries:   ${legacy.entries}`);
      console.log(`Plaintext tag names: ${legacy.tags}`);
      return;
    }
    case 'encrypt-existing': {
      requirePassword();
      const result = await backfill.encryptLegacyRows(db);
      console.log(
        `Encrypted ${result.entries} entries and ${result.tags} tag names.`,
      );
      if (!result.complete) {
        console.log('Some rows changed while running; run it again.');
        process.exitCode = 1;
      }
      return;
    }
    case 'add-password': {
      const current = requirePassword();
      const next = await readNewPassword();
      if (!next) throw new Error('The new password is empty.');
      const { added } = await slots.addPasswordSlot(db, current, next);
      console.log(
        added
          ? 'Added. Set AUTH_PASSWORD to the new password, redeploy, then run remove-other-slots with it.'
          : 'That password already opens the data key; nothing changed.',
      );
      return;
    }
    case 'remove-other-slots': {
      const { kept, removed } = await slots.removeOtherPasswordSlots(
        db,
        requirePassword(),
      );
      console.log(`Kept slot ${kept}, removed ${removed}.`);
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
