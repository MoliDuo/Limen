// Bootstrap loaded before test modules to set up the test environment.
import { setScryptParamsForNewSlots } from '@/lib/crypto/key-slots';
import { setDataKeySource } from '@/lib/crypto/cipher';
import { testDataKey } from './helpers/test-password';

// Does not override a caller-provided DATABASE_URL.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/limen_test';

// Every test database mints its own key slot; production-strength scrypt
// would add a third of a second to each one. Slots record their parameters,
// so this only affects how fast they are, never whether they open.
setScryptParamsForNewSlots({ N: 2 ** 10, r: 8, p: 1 });

// There is no request cookie in a test; open the key with the test password.
setDataKeySource(testDataKey);
