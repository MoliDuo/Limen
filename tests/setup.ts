// Bootstrap loaded before test modules to set up the test environment.
import { setScryptParamsForNewSlots } from '@/lib/crypto/key-slots';

// Does not override a caller-provided DATABASE_URL.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/limen_test';
// Field encryption unlocks its key with the master password.
process.env.AUTH_PASSWORD ??= 'test-master-password';

// Every test database mints its own key slot; production-strength scrypt
// would add a third of a second to each one. Slots record their parameters,
// so this only affects how fast they are, never whether they open.
setScryptParamsForNewSlots({ N: 2 ** 10, r: 8, p: 1 });
