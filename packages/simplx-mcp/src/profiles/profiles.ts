import type { PlatformConnection, ProdProfile, TestProfile } from "./types.js";

/**
 * Builds the read-only industrial/production profile. There is no
 * `allowWrite` flag to pass here — a `ProdProfile` structurally cannot carry
 * write capability, so no such option exists.
 */
export const createProdProfile = (connection: PlatformConnection): ProdProfile => ({
  ...connection,
  name: "prod",
});

/** Builds the test profile, which may write. */
export const createTestProfile = (connection: PlatformConnection): TestProfile => ({
  ...connection,
  name: "test",
  write: { __writeCapable: true },
});
