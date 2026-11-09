'use strict'
// Anthropic's API prices, the one table the Usage plugin prices transcripts with. Dollars per million
// tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-08; the
// table it replaced was cached 2026-10-06, and Sonnet 5.5's cache read changed from 0.20 to 0.10 in
// between). Update SOURCE_DATE with every edit: the panel says how old the table is.
//
// Cache writes are a multiple of the input price (5-minute TTL 1.25x, 1-hour TTL 2x), on every model
// and in fast mode too ("prompt caching multipliers apply on top of fast mode pricing"). A cache read
// is per model (0.1x input on most, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable / Mythos 5.1),
// so it is listed, not derived. Prices are what the API would bill: a subscription is not billed per
// token, which is why the UI calls every amount "API-equivalent".
//
// What is NOT priced (cost unknown, tokens still counted, never a guess): a model id not in the table
// (`<synthetic>`, a new model before this table knows it), and fast mode on a model with no fast
// price. Not modelled: the 1.1x US-only inference multiplier (`inference_geo`) and batch prices,
// neither of which Claude Code uses.

const SOURCE_DATE = '2026-11-08'
const SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'

const CACHE_5M = 1.25
const CACHE_1H = 2

/** Haiku 5.5 is priced by prompt length: input + cache read + cache write over this is "long". */
const HAIKU_55_LONG_PROMPT = 100000

/** `p(input, output, cacheRead)`: one price row. */
function p(input, output, cacheRead) {
  return { input, output, cacheRead }
}

/**
 * Model id (the API id, date suffix stripped) -> prices. `fast`: the `usage.speed: "fast"` row;
 * `long` (Haiku 5.5): the row for a prompt over HAIKU_55_LONG_PROMPT tokens.
 */
const MODELS = {
  'claude-fable-5-1': { std: p(10, 50, 0.25) },
  'claude-mythos-5-1': { std: p(10, 50, 0.25) },
  'claude-fable-5': { std: p(10, 50, 1) },
  'claude-mythos-5': { std: p(10, 50, 1) },
  // Fast: $8 / $40; the cache read keeps Opus 5.5's 0.05x multiplier on the fast input price.
  'claude-opus-5-5': { std: p(4, 20, 0.2), fast: p(8, 40, 0.4) },
  'claude-opus-5': { std: p(5, 25, 0.5), fast: p(10, 50, 1) },
  'claude-opus-4-8': { std: p(5, 25, 0.5), fast: p(10, 50, 1) },
  'claude-opus-4-7': { std: p(5, 25, 0.5) },
  'claude-opus-4-6': { std: p(5, 25, 0.5) },
  'claude-opus-4-5': { std: p(5, 25, 0.5) },
  'claude-opus-4-1': { std: p(15, 75, 1.5) },
  'claude-opus-4': { std: p(15, 75, 1.5) },
  'claude-sonnet-5-5': { std: p(2, 10, 0.1) },
  'claude-sonnet-5': { std: p(2, 10, 0.2) },
  'claude-sonnet-4-6': { std: p(3, 15, 0.3) },
  'claude-sonnet-4-5': { std: p(3, 15, 0.3) },
  'claude-sonnet-4': { std: p(3, 15, 0.3) },
  'claude-haiku-5-5': { std: p(0.1, 0.5, 0.01), long: p(0.5, 2.5, 0.05) },
  'claude-haiku-4-5': { std: p(1, 5, 0.1) }
}

/** The table's key for a transcript's `message.model`: exact, else with a `-YYYYMMDD` suffix taken off. */
function modelKey(model) {
  if (typeof model !== 'string') return undefined
  if (Object.prototype.hasOwnProperty.call(MODELS, model)) return model
  const bare = model.replace(/-\d{8}$/, '')
  return bare !== model && Object.prototype.hasOwnProperty.call(MODELS, bare) ? bare : undefined
}

/**
 * The tokens of one API message, split the way they are billed. `usage` is the transcript's
 * `message.usage`. A cache write with no `cache_creation` split (older Claude Code) is all 5-minute,
 * the cheaper TTL and Claude Code's default; a split that adds up to less than the total puts the
 * rest at 5 minutes too. Non-numbers and negatives count as 0.
 */
function tokensOf(usage) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const u = usage && typeof usage === 'object' ? usage : {}
  const write = n(u.cache_creation_input_tokens)
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null
  let w1h = split ? n(split.ephemeral_1h_input_tokens) : 0
  let w5m = split ? n(split.ephemeral_5m_input_tokens) : 0
  if (w1h + w5m > write && write > 0) {
    // A split larger than its total: trust the total, 1h first (it is what Claude Code asks for).
    w1h = Math.min(w1h, write)
    w5m = write - w1h
  } else if (w1h + w5m < write) {
    w5m += write - w1h - w5m
  }
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cache5m: w5m,
    cache1h: w1h,
    fast: u.speed === 'fast'
  }
}

/**
 * Dollars for one message (`tokensOf`'s result), or null when the model or its mode has no price.
 */
function costOf(model, t) {
  const key = modelKey(model)
  if (!key) return null
  const row = MODELS[key]
  let price = row.std
  if (t.fast) {
    if (!row.fast) return null
    price = row.fast
  } else if (row.long && t.input + t.cacheRead + t.cache5m + t.cache1h > HAIKU_55_LONG_PROMPT) {
    // The whole request pays the long prices, its cache hits included (pricing page, "Long context").
    price = row.long
  }
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      t.cache5m * price.input * CACHE_5M +
      t.cache1h * price.input * CACHE_1H) /
    1e6
  )
}

module.exports = { SOURCE_DATE, SOURCE_URL, MODELS, HAIKU_55_LONG_PROMPT, modelKey, tokensOf, costOf }
