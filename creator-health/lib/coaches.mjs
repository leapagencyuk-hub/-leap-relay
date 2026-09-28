// What to call a coach.
//
// The export identifies a coach by their email address, which is how every
// creator is keyed to them and how Discord routing resolves a mention. It is
// not what anybody calls them. Splitting the address at the @ produced
// "joshbates93" and "sherif.begain" on cards their own team reads, which is
// both ugly and, on a leaderboard, faintly rude.
//
// So the address stays the key everywhere, and this is the only place that
// decides what is printed. A coach with no entry falls back to the local part
// of their address, so a new hire shows up under something readable on day one
// rather than not at all.
const local = (email) => String(email ?? '').split('@')[0];

/** The display name for a coach, from `config.coaches.names`. */
export function coachName(email, config = {}) {
  if (!email || email === 'unassigned') return 'unassigned';
  const key = String(email).toLowerCase();
  return config.coaches?.names?.[key] ?? local(email);
}

/**
 * Coaches left off the boards.
 *
 * Separate from `monitoring.ignoreGroups`, which is about whole teams nobody
 * coaches. This is for people who are in the network but not in the internal
 * competition — an owner, an agency partner, somebody on cover.
 */
export function offTheBoards(email, config = {}) {
  if (!email) return false;
  const list = config.coaches?.excludeFromBoards ?? [];
  return list.map((e) => String(e).toLowerCase()).includes(String(email).toLowerCase());
}
