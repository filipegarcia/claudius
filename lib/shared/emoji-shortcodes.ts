/**
 * Pure (React-free) logic behind the `:shortcode:` emoji autocomplete in the
 * prompt composer (Claude Code 2.1.217 parity: "Added emoji shortcode
 * autocomplete in the prompt input: type `:heart:` to insert ❤️, or `:hea`
 * for suggestions — disable with the `emojiCompletionEnabled` setting").
 *
 * Kept in a plain `.ts` file (no React/lucide-react imports) so the node-only
 * vitest suite can exercise the trigger-detection and filtering logic
 * directly — same split as `at-mention.ts` / `slash-commands.ts`.
 *
 * The table below is a curated subset of the common GitHub/Slack shortcode
 * names, not an exhaustive Unicode CLDR dump — big enough to cover everyday
 * chat use without turning into a maintenance burden. Add to it as needed;
 * every key must be lowercase (lookups always lowercase the query).
 */
export const EMOJI_SHORTCODES: Record<string, string> = {
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  laughing: "😆",
  joy: "😂",
  rofl: "🤣",
  slightly_smiling_face: "🙂",
  wink: "😉",
  blush: "😊",
  innocent: "😇",
  relaxed: "☺️",
  heart_eyes: "😍",
  kissing_heart: "😘",
  thinking: "🤔",
  neutral_face: "😐",
  expressionless: "😑",
  no_mouth: "😶",
  smirk: "😏",
  unamused: "😒",
  roll_eyes: "🙄",
  grimacing: "😬",
  lying_face: "🤥",
  relieved: "😌",
  pensive: "😔",
  sleepy: "😪",
  sleeping: "😴",
  mask: "😷",
  sunglasses: "😎",
  nerd_face: "🤓",
  confused: "😕",
  worried: "😟",
  slightly_frowning_face: "🙁",
  frowning: "☹️",
  persevere: "😣",
  confounded: "😖",
  tired_face: "😫",
  weary: "😩",
  cry: "😢",
  sob: "😭",
  triumph: "😤",
  angry: "😠",
  rage: "😡",
  scream: "😱",
  fearful: "😨",
  cold_sweat: "😰",
  astonished: "😲",
  flushed: "😳",
  dizzy_face: "😵",
  exploding_head: "🤯",
  zany_face: "🤪",
  hugs: "🤗",
  shushing_face: "🤫",
  eyes: "👀",
  eye: "👁️",
  see_no_evil: "🙈",
  hear_no_evil: "🙉",
  speak_no_evil: "🙊",
  poop: "💩",
  clown_face: "🤡",
  skull: "💀",
  ghost: "👻",
  alien: "👽",
  robot: "🤖",
  heart: "❤️",
  orange_heart: "🧡",
  yellow_heart: "💛",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  black_heart: "🖤",
  broken_heart: "💔",
  two_hearts: "💕",
  sparkling_heart: "💖",
  heartbeat: "💓",
  heartpulse: "💗",
  cupid: "💘",
  sparkles: "✨",
  star: "⭐",
  star2: "🌟",
  boom: "💥",
  fire: "🔥",
  zap: "⚡",
  dizzy: "💫",
  100: "💯",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  clap: "👏",
  wave: "👋",
  raised_hands: "🙌",
  pray: "🙏",
  muscle: "💪",
  ok_hand: "👌",
  v: "✌️",
  crossed_fingers: "🤞",
  point_up: "☝️",
  point_down: "👇",
  point_left: "👈",
  point_right: "👉",
  handshake: "🤝",
  writing_hand: "✍️",
  raised_hand: "✋",
  facepunch: "👊",
  fist: "✊",
  rocket: "🚀",
  tada: "🎉",
  confetti_ball: "🎊",
  balloon: "🎈",
  gift: "🎁",
  trophy: "🏆",
  medal: "🏅",
  checkered_flag: "🏁",
  warning: "⚠️",
  no_entry: "⛔",
  x: "❌",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  question: "❓",
  exclamation: "❗",
  bulb: "💡",
  bug: "🐛",
  wrench: "🔧",
  hammer: "🔨",
  gear: "⚙️",
  lock: "🔒",
  unlock: "🔓",
  key: "🔑",
  mag: "🔍",
  bookmark: "🔖",
  memo: "📝",
  pencil2: "✏️",
  computer: "💻",
  keyboard: "⌨️",
  package: "📦",
  incoming_envelope: "📨",
  email: "✉️",
  calendar: "📅",
  hourglass: "⏳",
  alarm_clock: "⏰",
  stopwatch: "⏱️",
  coffee: "☕",
  pizza: "🍕",
  hamburger: "🍔",
  beer: "🍺",
  tada2: "🎊",
  moon: "🌙",
  sun: "☀️",
  cloud: "☁️",
  rainbow: "🌈",
  snowflake: "❄️",
  dog: "🐶",
  cat: "🐱",
  monkey: "🐒",
  unicorn: "🦄",
  turtle: "🐢",
  octopus: "🐙",
  seedling: "🌱",
  tree: "🌳",
  palm_tree: "🌴",
  four_leaf_clover: "🍀",
  earth_americas: "🌎",
  globe_with_meridians: "🌐",
  car: "🚗",
  airplane: "✈️",
  house: "🏠",
  office: "🏢",
  camera: "📷",
  telephone: "☎️",
  loudspeaker: "📢",
  bell: "🔔",
  no_bell: "🔕",
  recycle: "♻️",
  infinity: "♾️",
  arrows_counterclockwise: "🔄",
  arrow_right: "➡️",
  arrow_left: "⬅️",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
};

/** Max rows the emoji picker ever shows — matches `PICKER_LIMIT` in at-mention.ts. */
export const EMOJI_PICKER_LIMIT = 30;

/**
 * Match a trailing, still-open `:shortcode` token in `before` (the text up
 * to the caret) — same anchoring shape as the `@`-mention regex in
 * `PromptInput.refreshPickerState`: the trigger must start a token (preceded
 * by start-of-string or whitespace) so mid-word colons (`http:`, `10:30`)
 * never fire. Returns the partial name typed so far (without colons), or
 * `null` if there's no open trigger.
 */
export function parseEmojiTrigger(before: string): string | null {
  const m = /(^|\s):([a-zA-Z0-9_+-]*)$/.exec(before);
  return m ? m[2] : null;
}

/**
 * Case-insensitive filter over the shortcode table: names starting with the
 * query sort first (alphabetically), then names merely containing it
 * elsewhere — mirrors the fuzzy-ish ranking `SlashCommandPicker` uses so the
 * closest match is always the top (Tab-able) row. Capped at
 * {@link EMOJI_PICKER_LIMIT}.
 */
export function filterEmojiShortcodes(query: string): Array<{ name: string; emoji: string }> {
  const needle = query.toLowerCase();
  const all = Object.entries(EMOJI_SHORTCODES);
  const starts: Array<{ name: string; emoji: string }> = [];
  const contains: Array<{ name: string; emoji: string }> = [];
  for (const [name, emoji] of all) {
    if (!needle) {
      starts.push({ name, emoji });
      continue;
    }
    if (name.startsWith(needle)) starts.push({ name, emoji });
    else if (name.includes(needle)) contains.push({ name, emoji });
  }
  starts.sort((a, b) => a.name.localeCompare(b.name));
  contains.sort((a, b) => a.name.localeCompare(b.name));
  return [...starts, ...contains].slice(0, EMOJI_PICKER_LIMIT);
}

/** Exact-match lookup (case-insensitive) used by the auto-complete-on-`:`-close path. */
export function lookupEmojiShortcode(name: string): string | undefined {
  return EMOJI_SHORTCODES[name.toLowerCase()];
}
