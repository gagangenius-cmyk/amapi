import 'dotenv/config';

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

/**
 * No silent fallback secret: a server started without JWT_SECRET (or with a placeholder) would accept forged tokens.
 * Only a secret that starts with "dev-" is tolerated outside production, so local development stays easy.
 */
function resolveJwtSecret(): string {
  const s = process.env.JWT_SECRET ?? (isTest ? 'dev-test-secret-not-for-production' : '');
  if (!s) throw new Error('JWT_SECRET is not set. Generate one, e.g. `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"`');
  if (isProd) {
    if (s.length < 32 || s.startsWith('dev-') || s.startsWith('change-me')) throw new Error('JWT_SECRET must be a random string of at least 32 characters in production');
  } else if (!s.startsWith('dev-') && s.length < 32) {
    throw new Error('JWT_SECRET is too weak. Use 32+ random characters (or a "dev-..." value for local development only).');
  }
  return s;
}

export const env = {
  isTest,
  isProd,
  port: Number(process.env.PORT ?? 4000),
  // Tests NEVER read the app's DB_* settings: they wipe their database, so they only use TEST_DB_* (local by default).
  db: isTest
    ? {
        host: process.env.TEST_DB_HOST ?? '127.0.0.1',
        port: Number(process.env.TEST_DB_PORT ?? 3306),
        user: process.env.TEST_DB_USER ?? 'root',
        password: process.env.TEST_DB_PASSWORD ?? '',
        database: process.env.TEST_DB_NAME ?? 'aymee_test',
      }
    : {
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? 'root',
        password: process.env.DB_PASSWORD ?? '',
        database: process.env.DB_NAME ?? 'aymee',
      },
  /** Schema changes (migrations) may need more rights than the running app; set MIGRATE_DB_USER/PASSWORD to use a separate account. */
  migrateDb: {
    user: process.env.MIGRATE_DB_USER,
    password: process.env.MIGRATE_DB_PASSWORD,
  },
  jwtSecret: resolveJwtSecret(),
  /** Admin accounts must have two-factor on to use admin endpoints. On by default in production; ADMIN_REQUIRE_2FA=0/1 overrides. */
  /** Second factor for admin/company-employee sign-in. 'email' (current, temporary) emails a code on every sign-in; 'totp' is the authenticator-app flow (kept, switched off for now). */
  twoFactorMethod: (process.env.TWO_FACTOR_METHOD === 'totp' ? 'totp' : 'email') as 'totp' | 'email',
  /** TEMPORARY testing aid: this fixed code (default 123456) is accepted as the emailed sign-in code for admin/company-employee accounts (password is still required). TEST_OTP=off turns it off; TEST_OTP=<6 digits> changes it. Never active under test. */
  testOtp: (() => { const v = process.env.TEST_OTP ?? '123456'; return isTest || !/^\d{6}$/.test(v) ? null : v; })(),
  /** Accounts (email or phone, comma-separated) for which TEST_OTP also works on the passwordless "sign in with a code" screen. Sign-in only, never password reset. Set TEST_OTP_ACCOUNTS=none to disable. */
  testOtpAccounts: (process.env.TEST_OTP_ACCOUNTS ?? 'sales.subodh@gmail.com,9813094441').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x && x !== 'none'),
  /** TESTING PERIOD: distributor onboarding is free (fee ₹0, no payment step; the account goes live at once). Default on for now. Set FREE_ONBOARDING=0 to charge the plan fee again. */
  get freeOnboarding() { return process.env.FREE_ONBOARDING !== '0'; },
  adminRequires2fa:process.env.ADMIN_REQUIRE_2FA ? process.env.ADMIN_REQUIRE_2FA === '1' : isProd,
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  accessTtlMin: Number(process.env.ACCESS_TTL_MIN ?? 15),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
  /** Returning OTP codes in API responses is a development convenience and is impossible in production. */
  get otpDevEcho() { return !isProd && process.env.OTP_DEV_ECHO === '1'; },
};

if (isProd) {
  if (!env.db.password) throw new Error('DB_PASSWORD must be set in production');
  if (process.env.OTP_DEV_ECHO === '1') throw new Error('OTP_DEV_ECHO must not be set in production: it would return login codes to anyone');
  if (env.db.user === 'root' && !process.env.ALLOW_DB_ROOT) throw new Error('Do not run the API as the database root user. Create a limited user (see DEPLOYMENT.md) or set ALLOW_DB_ROOT=1 to override.');
} else if (!isTest && !process.env.NODE_ENV) {
  console.warn('[config] NODE_ENV is not set; running with development settings. Set NODE_ENV=production on servers.');
}
if (env.testOtp) console.warn('[config] TEST_OTP is active: a fixed sign-in code is accepted for admin/employee accounts. Set TEST_OTP=off before real use.');
if (env.otpDevEcho && !isTest) console.warn('[config] OTP_DEV_ECHO is on: login codes are returned in API responses (development only).');
