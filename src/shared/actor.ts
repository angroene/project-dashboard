/** The actor name of the dashboard user in history entries and attachments; agents cannot write under it. */
export const USER_ACTOR = "user";

/**
 * True when a name reads as the dashboard user's: its letters and digits (any case) start with "user". Covers
 * look-alikes such as "User (dashboard)", "u-s-e-r" or "user-ci". Agent `by` names and token names must not.
 */
export const isReservedActorName = (name: string): boolean =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(USER_ACTOR);

export const RESERVED_ACTOR_RULE = `must not start with "${USER_ACTOR}" (letters and digits, any case; reserved for the dashboard user)`;
