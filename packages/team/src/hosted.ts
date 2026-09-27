/**
 * The Vibez team server everyone uses unless they bring their own: one
 * Supabase project run by the Vibez team, so starting a team takes a team
 * name and your name, and nobody pays or sets anything up.
 *
 * The anon key is Supabase's public key and is meant to ship in clients:
 * row-level security is what keeps each team's rows to its members.
 * Undefined until the hosted project exists (see supabase/README.md).
 */
export const HOSTED_TEAM_SERVER: { url: string; anonKey: string } | undefined = undefined;
