/**
 * The Vibez team server everyone uses unless they bring their own: one
 * Supabase project run by the Vibez team, so starting a team takes a team
 * name and your name, and nobody pays or sets anything up.
 *
 * The anon key is Supabase's public key and is meant to ship in clients:
 * row-level security is what keeps each team's rows to its members.
 * Written by scripts/team-host.ts.
 */
export const HOSTED_TEAM_SERVER: { url: string; anonKey: string } | undefined = {
  url: "https://phzzayxdevxpiozppbpe.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoenpheXhkZXZ4cGlvenBwYnBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NjU0NjUsImV4cCI6MjEwNjA0MTQ2NX0.8a-hqBnVGBicfJjGxWgDSDzc_PMynXiagohVpD97Zs0",
};
