/**
 * Local password hashing and verification.
 *
 * Uses Node's built-in scrypt implementation so enterprise local auth does
 * not add a native dependency. Stored hashes have this format:
 *
 * `scrypt$16384$8$1$<salt_b64>$<hash_b64>`
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions,
} from 'node:crypto';

function scrypt(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Validate the local password policy.
 *
 * @param plain - Candidate plaintext password.
 * @returns `null` when valid, otherwise a human-readable failure message.
 */
export function validatePasswordPolicy(plain: string): string | null {
  if (plain.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(plain)) return 'Password must include at least one letter.';
  if (!/\d/.test(plain)) return 'Password must include at least one digit.';
  return null;
}

/**
 * Hash a plaintext password with scrypt.
 *
 * @param plain - Plaintext password.
 * @returns A serialized scrypt hash string.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(plain, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;

  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 *
 * Malformed stored values are treated as authentication failure. This function
 * never throws; callers can use a single invalid-credentials response path.
 *
 * @param plain - Candidate plaintext password.
 * @param stored - Serialized scrypt hash.
 * @returns `true` when the password matches, otherwise `false`.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;

    const key = await scrypt(plain, parsed.salt, KEY_BYTES, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    }) as Buffer;

    return timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

function parseStoredHash(stored: string): {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
} | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (scheme !== 'scrypt') return null;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;

  const salt = Buffer.from(saltRaw, 'base64');
  const hash = Buffer.from(hashRaw, 'base64');
  if (salt.length !== SALT_BYTES || hash.length !== KEY_BYTES) return null;

  return { n, r, p, salt, hash };
}
