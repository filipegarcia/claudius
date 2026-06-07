/**
 * Time-of-day greeting used by the splash screen. Mirrors the
 * Claude WebUI vibe ("Good evening, Filipe") but rotates between many
 * phrasings so a heavy user doesn't see the literal same string every
 * time they open a fresh session.
 *
 * Two kinds of phrases:
 *   - PLAIN: just a phrase. When a name is known, we append ", <name>"
 *     so "Hello" → "Hello, Filipe".
 *   - TEMPLATED: contains "{name}" — we substitute the name in place,
 *     making room for playful "The return of <name>" / "It's <name>!"
 *     style greetings. Templated phrases are filtered out when no name
 *     is known (substituting "{name}" with an empty string would read
 *     terribly).
 *
 * The pool is split by time band PLUS a shared "anytime" bucket that
 * mixes into every band — that's where the most varied and funniest
 * lines live, so they can fire at any hour.
 *
 * Pure function — caller owns when to compute it (use inside a useMemo
 * so it stays stable across re-renders of the splash).
 */

type Band = "morning" | "afternoon" | "evening" | "night";

const NAME_TOKEN = "{name}";

/**
 * Lines that only make sense at a specific time of day. Kept small —
 * the bulk of variety lives in ANYTIME below.
 */
const BAND_PHRASES: Record<Band, string[]> = {
  morning: [
    "Good morning",
    "Morning",
    "Rise and shine",
    "Top of the morning",
    "Coffee's ready",
    "Good morning, {name}",
    "Up bright and early, {name}?",
  ],
  afternoon: [
    "Good afternoon",
    "Afternoon",
    "Good afternoon, {name}",
    "Afternoon, {name}",
    "Hope your day's going well, {name}",
  ],
  evening: [
    "Good evening",
    "Evening",
    "Good evening, {name}",
    "Evening, {name}",
    "Winding down or just getting started, {name}?",
  ],
  night: [
    "Working late",
    "Still up",
    "Burning the midnight oil",
    "Working late, {name}?",
    "Still up, {name}?",
    "The night is young, {name}",
  ],
};

/**
 * Lines that fit at any hour. Mixed into every band's pool. Templated
 * entries only fire when a name is known.
 */
const ANYTIME_PHRASES: string[] = [
  // Plain — no name needed
  "Hello",
  "Hey there",
  "Hi!",
  "Welcome back",
  "Howdy",
  "Greetings",
  "What are we building today?",
  "Ready to ship?",
  "Let's go",
  "Let's build something",
  "What's cooking?",
  "Back at it",
  "At your service",
  // Templated — substituted only when a name is known
  "Hello, {name}",
  "Hey, {name}",
  "Welcome back, {name}",
  "Howdy, {name}",
  "Greetings, {name}",
  "The return of {name}",
  "Look who's back — {name}",
  "It's {name}!",
  "{name} is in the building",
  "Ah, {name}. We meet again",
  "{name} returns",
  "Long time no see, {name}",
  "Reporting for duty, {name}?",
  "Ready to ship, {name}?",
  "What's cooking, {name}?",
  "{name}, at your service",
  "Salutations, {name}",
  "Welcome to the lair, {name}",
  "Greetings, traveler {name}",
  "Behold, {name}",
];

export function timeBand(hour: number): Band {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * Pick one of the eligible phrases. `seed` lets callers stabilize the
 * choice across renders within an hour (e.g. seed with
 * `Math.floor(Date.now() / 3_600_000)` — hour-of-epoch — so the phrase
 * rotates every hour but never mid-render). When `seed` is omitted we
 * fall back to the hour itself.
 *
 * When `name` is null, templated phrases are filtered out so we don't
 * surface "Hello, {name}" with an empty substitution.
 */
export function pickGreeting(opts: { hour: number; seed?: number; name?: string | null }): string {
  const band = timeBand(opts.hour);
  const pool = [...BAND_PHRASES[band], ...ANYTIME_PHRASES];
  const eligible = opts.name
    ? pool
    : pool.filter((p) => !p.includes(NAME_TOKEN));
  const seed = opts.seed ?? opts.hour;
  const choice = eligible[Math.abs(seed) % eligible.length];
  return opts.name ? choice.replaceAll(NAME_TOKEN, opts.name) : choice;
}

/**
 * Combine a greeting with a name. When the chosen phrase already
 * embeds {name} (templated) we use it verbatim; otherwise we append ",
 * <name>" so a plain "Hello" becomes "Hello, Filipe". Returns the
 * phrase bare when no name is known.
 */
export function greetingFor(name: string | null, opts: { hour: number; seed?: number }): string {
  const phrase = pickGreeting({ ...opts, name });
  if (!name) return phrase;
  // pickGreeting already substituted any {name} token. If the chosen
  // phrase mentioned the name (substituted form contains the name),
  // don't double it up; otherwise append ", <name>" so plain phrases
  // ("Hello") still address the user.
  if (phrase.includes(name)) return phrase;
  return `${phrase}, ${name}`;
}
