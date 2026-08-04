// server/domain-seed.js — THE CURATED HEAD OF THE INTERNET.
// SHARED-WORLD.md §7 Phase 6 increment 6b. Read `domains.js` first; this is only its data.
//
// WHY A HAND-WRITTEN LIST EXISTS AT ALL. Sites should be near sites like them — social beside social, shops
// beside shops — and there is no way to know what an arbitrary website IS from its address. For the long tail
// there is nothing to do but scatter it. For the head there is: measured, the **top 10 websites are ~69% of all
// visits**, so a list of a few dozen names covers most of where people actually are. That makes this a small
// file with a large effect, which is the only reason it is worth the maintenance it will cost.
//
// ⚠️ IT WILL GO STALE and that is accepted. The version that scales is placing sites near others the same people
// visit in the same session (co-visitation), which needs usage data we do not have. This is the bootstrap for
// that, not a competitor to it.
//
// ⚠️ `weight` IS NOT A LAND CLAIM. Territory is never granted — it grows from activity. Weight only sets how
// widely a site's ARRIVALS are scattered, so a busy site's first hundred visitors do not all land on one another.
// 3 = enormous, 2 = busy, 1 = ordinary. (User's correction, 2026-08-04: the earlier note in SHARED-WORLD that
// read "no adaptive sizing" meant "no GRANTED plots", not "no variation in starting radius".)
'use strict';

// ⭐ ORDER MATTERS: categories are laid along the world in this order, so neighbours here are neighbours there.
// Chosen so each adjacent pair has something to do with the other — work↔dev↔reference↔news↔social↔video↔
// gaming↔shopping↔finance — rather than by alphabet.
const CATEGORIES = ['work', 'dev', 'reference', 'news', 'social', 'video', 'gaming', 'shopping', 'finance'];

// site -> [category, weight]. Ranked by TOTAL ATTENTION (visits × time on site), not visits alone: Google takes
// far more visits than YouTube but at ~10 minutes a visit against ~20, so the gap is 1.45× rather than 2.8×, and
// further down the list it reorders outright — Discord, Roblox and Telegram all sit far above their visit rank.
const SEED = {
  // ── search & reference ──────────────────────────────────────────────────────────────────────────────────
  'google.com': ['reference', 3], 'bing.com': ['reference', 2], 'yandex.ru': ['reference', 2],
  'baidu.com': ['reference', 2], 'duckduckgo.com': ['reference', 1], 'wikipedia.org': ['reference', 2],
  'yahoo.com': ['reference', 2], 'yahoo.co.jp': ['reference', 2], 'naver.com': ['reference', 2],
  'chatgpt.com': ['reference', 2], 'claude.ai': ['reference', 1], 'perplexity.ai': ['reference', 1],
  'archive.org': ['reference', 1], 'quora.com': ['reference', 1],
  // ── news ────────────────────────────────────────────────────────────────────────────────────────────────
  'bbc.co.uk': ['news', 2], 'bbc.com': ['news', 2], 'cnn.com': ['news', 2], 'nytimes.com': ['news', 2],
  'theguardian.com': ['news', 2], 'foxnews.com': ['news', 1], 'dzen.ru': ['news', 1],
  'news.ycombinator.com': ['news', 1], 'weather.com': ['news', 1],
  // ── social ──────────────────────────────────────────────────────────────────────────────────────────────
  'facebook.com': ['social', 3], 'instagram.com': ['social', 3], 'x.com': ['social', 3],
  'twitter.com': ['social', 3], 'reddit.com': ['social', 3], 'tiktok.com': ['social', 3],
  'linkedin.com': ['social', 2], 'whatsapp.com': ['social', 2], 'telegram.org': ['social', 2],
  'discord.com': ['social', 2], 'pinterest.com': ['social', 2], 'snapchat.com': ['social', 1],
  'vk.com': ['social', 2], 'tumblr.com': ['social', 1], 'bsky.app': ['social', 1],
  // ── video & streaming ───────────────────────────────────────────────────────────────────────────────────
  'youtube.com': ['video', 3], 'netflix.com': ['video', 2], 'twitch.tv': ['video', 2],
  'bilibili.com': ['video', 2], 'disneyplus.com': ['video', 1], 'spotify.com': ['video', 2],
  'soundcloud.com': ['video', 1], 'vimeo.com': ['video', 1], 'primevideo.com': ['video', 1],
  // ── gaming ──────────────────────────────────────────────────────────────────────────────────────────────
  'roblox.com': ['gaming', 2], 'steampowered.com': ['gaming', 2], 'epicgames.com': ['gaming', 1],
  'minecraft.net': ['gaming', 1], 'chess.com': ['gaming', 1], 'itch.io': ['gaming', 1],
  'ea.com': ['gaming', 1], 'nintendo.com': ['gaming', 1],
  // ── shopping ────────────────────────────────────────────────────────────────────────────────────────────
  'amazon.com': ['shopping', 3], 'amazon.co.uk': ['shopping', 2], 'ebay.com': ['shopping', 2],
  'aliexpress.com': ['shopping', 2], 'etsy.com': ['shopping', 1], 'walmart.com': ['shopping', 2],
  'temu.com': ['shopping', 2], 'ozon.ru': ['shopping', 1], 'shopify.com': ['shopping', 1],
  'booking.com': ['shopping', 1],
  // ── finance ─────────────────────────────────────────────────────────────────────────────────────────────
  'paypal.com': ['finance', 2], 'coinbase.com': ['finance', 1], 'binance.com': ['finance', 1],
  'chase.com': ['finance', 1], 'tradingview.com': ['finance', 1],
  // ── work & productivity ─────────────────────────────────────────────────────────────────────────────────
  'office.com': ['work', 2], 'microsoft.com': ['work', 2], 'live.com': ['work', 2],
  'zoom.us': ['work', 2], 'slack.com': ['work', 1], 'notion.so': ['work', 1],
  'dropbox.com': ['work', 1], 'canva.com': ['work', 2], 'indeed.com': ['work', 1],
  'instructure.com': ['work', 1], 'salesforce.com': ['work', 1],
  // ── developer & tech ────────────────────────────────────────────────────────────────────────────────────
  'github.com': ['dev', 2], 'stackoverflow.com': ['dev', 2], 'gitlab.com': ['dev', 1],
  'npmjs.com': ['dev', 1], 'apple.com': ['dev', 2], 'cloudflare.com': ['dev', 1],
  'mozilla.org': ['dev', 1], 'w3schools.com': ['dev', 1],
};

// ⭐ SHARED PLATFORMS — hosts whose SUBDOMAINS ARE REALLY PAGES.
// `someone.tumblr.com` and `user.github.io` are subdomains by the mechanical rule, and there are millions of
// them; giving each one its own place in the world would fill it many times over. So they collapse entirely into
// the parent instead — which is the user's own ordering applied deliberately: *when uncertain, treat a thing as
// part of its host first, its own page second, and its own place in the world last*, because being wrong that
// way costs a little character and being wrong the other way costs the world.
const SHARED_PLATFORMS = new Set([
  'tumblr.com', 'github.io', 'wordpress.com', 'blogspot.com', 'medium.com', 'substack.com',
  'wixsite.com', 'weebly.com', 'squarespace.com', 'netlify.app', 'vercel.app', 'pages.dev',
  'herokuapp.com', 'glitch.me', 'itch.io', 'neocities.org', 'myshopify.com', 'notion.site',
  'fandom.com', 'gitbook.io', 'readthedocs.io', 'firebaseapp.com', 'web.app', 'repl.co',
]);

module.exports = { CATEGORIES, SEED, SHARED_PLATFORMS };
