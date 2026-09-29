import { existsSync } from 'node:fs';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  const envFile = ['.env.local', '.env'].find((candidate) =>
    existsSync(candidate),
  );
  if (envFile) process.loadEnvFile(envFile);
}

const MIN_PASSWORD_LENGTH = 12;

const USAGE = `Usage: npm run crypto -- <command>

  status               How many key slots of each kind exist
  init                 Set the master password on a new, empty database
  change-password      Replace the master password and sign out every device
  revoke-sessions      Sign out every device

Passwords are asked for on the terminal; piped input is read one per line.
DATABASE_URL comes from the environment or .env.local. See docs/encryption.md.`;

let pipedLines: string[] | null = null;

async function readPipedLine() {
  if (!pipedLines) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

/** Reads a line without echoing it. */
async function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return readPipedLine();
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function askNewPassword() {
  const first = await askHidden('New password: ');
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const second = await askHidden('Repeat it: ');
  if (first !== second) throw new Error('The two passwords differ.');
  return first;
}

async function main() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const [{ db }, slots] = await Promise.all([
    import('../src/lib/db/index'),
    import('../src/lib/crypto/key-slots'),
  ]);

  switch (command) {
    case 'status': {
      const counts = await slots.countKeySlots(db);
      console.log(`Password slots:      ${counts.password}`);
      console.log(`Signed-in sessions:  ${counts.session}`);
      console.log(`API tokens:          ${counts.api_token}`);
      return;
    }
    case 'init': {
      if ((await slots.countPasswordSlots(db)) > 0) {
        throw new Error(
          'A master password is already set. Use change-password to replace it.',
        );
      }
      await slots.unlockDataKey(db, await askNewPassword());
      console.log('Master password set. Keep it in a password manager.');
      return;
    }
    case 'change-password': {
      const current = await askHidden('Current password: ');
      const next = await askNewPassword();
      if (!(await slots.changePassword(db, current, next))) {
        throw new Error('Wrong password.');
      }
      console.log('Password changed. Every device has been signed out.');
      return;
    }
    case 'revoke-sessions': {
      const removed = await slots.revokeSessions(db);
      console.log(
        `Signed out ${removed.length} session(s). Other instances may keep serving them for up to a minute.`,
      );
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
