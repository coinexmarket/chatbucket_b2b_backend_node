/**
 * Request bodies for authentication and profile routes.
 *
 * Ported from `app/models/auth.py`. Two pydantic behaviours had to be rebuilt by
 * hand here, because zod does not do them for you:
 *
 *   1. **camelCase and snake_case are both accepted.** The frontend posts
 *      `howDidYouHear`; older integrations post `how_did_you_hear`. Handled by
 *      `withAliases` below rather than by duplicating every field.
 *   2. **Unknown fields are rejected, not dropped.** zod's default is to strip
 *      them, which means a form posting a field the API does not model gets a
 *      201 and loses it silently. `.strict()` turns that into an obvious
 *      integration error.
 */
import { z } from 'zod';

// E.164: '+', a country code that cannot start with 0, and 15 digits at most.
// Stored in this one canonical form so a gateway can dial it without the app
// having to guess a country later.
const E164 = /^\+[1-9]\d{7,14}$/;
const PHONE_SEPARATORS = /[\s\-().]/g;

/**
 * Strip formatting and validate as E.164, or throw with what to fix.
 *
 * The signup form has a country selector, so the number arrives with a dial code
 * already; what varies is how the user typed the rest. "+91 98765-43210" and
 * "+919876543210" are the same number and must not become two stored values.
 */
export function normalizePhone(value: string): string {
  const cleaned = value.trim().replace(PHONE_SEPARATORS, '');
  if (!cleaned.startsWith('+')) {
    throw new Error('Mobile number must start with a country code, e.g. +919876543210.');
  }
  if (!E164.test(cleaned)) {
    throw new Error(
      'Mobile number must be 8-15 digits in international format, e.g. +919876543210.',
    );
  }
  return cleaned;
}

const phone = z.string().transform((value, ctx) => {
  try {
    return normalizePhone(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'Invalid mobile number.',
    });
    return z.NEVER;
  }
});

/**
 * Lowercased and trimmed, so one address cannot become two accounts.
 *
 * **Trimmed before validating, not after.** zod applies `.email()` to the raw
 * string, so `" ada@x.com "` would be rejected — while pydantic's `EmailStr`
 * strips first and accepts it. Validating first would mean a customer who typed
 * a trailing space got a 422 here and a 201 from the Python service, which is
 * precisely the kind of divergence that makes a split-traffic cutover unsafe.
 */
/**
 * Domains reserved by RFC 6761, which can never receive mail.
 *
 * pydantic's `EmailStr` refuses them and zod's `.email()` does not — the one
 * place the two validators disagreed when the live services were diffed. Left
 * alone, this service would accept a registration the Python one rejects, so an
 * address could exist here that the other half of the system considers invalid.
 */
const UNROUTABLE_TLDS = new Set(['invalid', 'test', 'localhost', 'example']);

export const email = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().email('Enter a valid email address.'))
  .refine(
    (address) => {
      const tld = address.split('@')[1]?.split('.').pop() ?? '';
      return !UNROUTABLE_TLDS.has(tld);
    },
    { message: 'Enter a valid email address.' },
  );

/**
 * Accept `snake_case` alongside the canonical `camelCase` key.
 *
 * Applied before parsing so the schema itself only ever describes one spelling.
 */
function withAliases<T extends z.ZodTypeAny>(schema: T, aliases: Record<string, string>) {
  return z.preprocess((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...input };
    for (const [snake, camel] of Object.entries(aliases)) {
      if (snake in out && !(camel in out)) {
        out[camel] = out[snake];
        delete out[snake];
      }
    }
    return out;
  }, schema);
}

export const RegisterRequest = withAliases(
  z
    .object({
      name: z.string().min(1).max(120),
      email,
      password: z.string().min(8, 'Password must be at least 8 characters.').max(128),
      mobile: phone,
      company: z.string().max(200).nullish(),
      // Free text rather than an enum: the signup form owns the option list, so
      // it can add or reword a choice without a backend deploy.
      howDidYouHear: z.string().max(200).nullish(),
      // Required and must be true. Recorded as a timestamp on the user — a
      // consent record you cannot date is not a record.
      acceptTerms: z.literal(true, {
        errorMap: () => ({
          message: 'You must accept the Terms & Conditions to create an account.',
        }),
      }),
    })
    .strict(),
  {
    how_did_you_hear: 'howDidYouHear',
    accept_terms: 'acceptTerms',
  },
);
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z
  .object({ email, password: z.string().min(1) })
  .strict();

/**
 * The six digits texted to a mobile number, plus the number itself.
 *
 * Takes the number rather than a session for the same reason the email OTP takes
 * an address: someone verifying on a phone may not be signed in. The number must
 * be in the same E.164 form it was registered with, so the lookup is exact.
 */
export const VerifyPhoneRequest = z
  .object({ mobile: phone, code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code.') })
  .strict();

export const ResendPhoneCodeRequest = z.object({ mobile: phone }).strict();

export const VerifyEmailOtpRequest = z
  .object({ email, code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code.') })
  .strict();

export const ForgotPasswordRequest = z.object({ email }).strict();

export const ResetPasswordRequest = withAliases(
  z
    .object({
      token: z.string().min(1),
      newPassword: z.string().min(8, 'Password must be at least 8 characters.').max(128),
    })
    .strict(),
  { new_password: 'newPassword' },
);

export const VerifyEmailRequest = z.object({ token: z.string().min(1) }).strict();

export const RefreshRequest = withAliases(
  z.object({ refreshToken: z.string().min(1) }).strict(),
  { refresh_token: 'refreshToken' },
);

export const LogoutRequest = withAliases(
  z
    .object({
      refreshToken: z.string().min(1).optional(),
      allSessions: z.boolean().default(false),
    })
    .strict(),
  { refresh_token: 'refreshToken', all_sessions: 'allSessions' },
);

export const ChangePasswordRequest = withAliases(
  z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8, 'Password must be at least 8 characters.').max(128),
    })
    .strict(),
  { current_password: 'currentPassword', new_password: 'newPassword' },
);

export const ProfileUpdateRequest = z
  .object({
    name: z.string().min(1).max(120).optional(),
    company: z.string().max(200).nullish(),
    phone: phone.optional(),
  })
  .strict();
