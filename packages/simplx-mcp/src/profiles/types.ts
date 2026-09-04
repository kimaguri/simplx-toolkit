/**
 * Connection details shared by every profile: which platform tenant to talk
 * to and how to authenticate. No profile logic lives here beyond shape.
 */
export interface PlatformConnection {
  readonly baseUrl: string;
  readonly tenantSlug: string;
  readonly bearerToken: string;
}

/**
 * Marker carried only by profiles allowed to reach write paths. Its presence
 * (not a boolean, not a name string) is what write-capable APIs check for at
 * the type level, so there is nothing to flip and nothing to bypass at
 * runtime.
 */
export interface WriteCapability {
  readonly __writeCapable: true;
}

/** The industrial/production profile. Structurally has no `write` member. */
export interface ProdProfile extends PlatformConnection {
  readonly name: "prod";
}

/** The test profile. Carries {@link WriteCapability}, so it satisfies {@link WriteCapableProfile}. */
export interface TestProfile extends PlatformConnection {
  readonly name: "test";
  readonly write: WriteCapability;
}

export type Profile = ProdProfile | TestProfile;

/**
 * Any profile carrying {@link WriteCapability}. Write-path functions accept
 * this type instead of the {@link Profile} union, so passing a
 * {@link ProdProfile} — which has no `write` member — fails at `tsc` time,
 * not at runtime. See `test/profiles.type-test.ts` for the proof.
 */
export type WriteCapableProfile = Extract<Profile, { readonly write: WriteCapability }>;
