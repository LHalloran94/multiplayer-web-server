'use strict';
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  ITEMS — the things you carry that are not terrain (weapons, tools, the torch, throwables, worn gear).
//
//  ⭐⭐ AN ITEM IS A KIND PLUS A COUNT, EXACTLY LIKE A MATERIAL (user decision 2026-10-07, `weapons_ideas.md` §5
//  item 11). Two of the same item are identical: no wear, no quality, no maker, nothing loaded in it. A BETTER
//  weapon is a DIFFERENT ITEM ("Iron sword" / "Fine iron sword"), like a rarity tier with its own stats. One-of-a-
//  kind items were considered and deliberately left for later ("getting ahead of ourselves").
//  ⇒ the ledger holds `itemId → n` beside `matId → n`, and everything that moves matter (credit, spend, the death
//  scatter, a pile, a pickup) moves items the same way. No new trust machinery.
//
//  ⭐ THIS TABLE IS THE ONLY COPY. The client is SENT it (on the first `inv-sync` of a socket) rather than keeping
//  its own list — two tables of what exists is the drift this project keeps getting caught by. That is also why
//  the picture rides along here: the client draws what it is told.
//
//  ⚠️ IDS ARE STRINGS and are what gets STORED (ledger rows, pile rows). Renaming one strands everybody's copy of
//  it. Add new ids; do not rename old ones.
//
//  ⏭️ NOTHING HERE DOES ANYTHING YET. The first build (inventory + hotbar) only makes room: holding an item in dig
//  mode switches digging, placing and the dig preview off, and that is all. The three `test` items exist so the
//  bar can be played with before any real item does; they come from the debug panel and nowhere else.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

// The pictures, as 24×24 SVG. Drawn by the client both in the window (as markup) and on the canvas (as an image).
const SVG = {
  sword: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20.6 2.4 L21.6 3.4 L11 15 L9 13 Z" fill="#dfe5ec" stroke="#5b6472" stroke-width=".7"/>'
    + '<path d="M7 11.6 L12.4 17" stroke="#8a6a44" stroke-width="2.4" stroke-linecap="round"/>'
    + '<path d="M9.7 14.3 L4.6 19.4" stroke="#5a4028" stroke-width="2.3" stroke-linecap="round"/><circle cx="3.9" cy="20.1" r="1.4" fill="#8a6a44"/></svg>',
  torch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="10.6" y="10.5" width="2.8" height="11" rx="1" fill="#7a5530"/>'
    + '<path d="M12 1.8c3 3.5 3.6 5.6 3.3 7.3-.3 1.6-1.6 2.9-3.3 2.9s-3-1.3-3.3-2.9C8.4 7.4 9 5.3 12 1.8z" fill="#f59e0b"/>'
    + '<path d="M12 5.8c1.4 1.7 1.7 2.8 1.5 3.7-.2.8-.8 1.4-1.5 1.4s-1.3-.6-1.5-1.4c-.2-.9.1-2 1.5-3.7z" fill="#fde68a"/></svg>',
  arrows: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g stroke-linecap="round"><path d="M4 18 L17 5" stroke="#9a7b4f" stroke-width="1.6"/><path d="M7 21 L20 8" stroke="#9a7b4f" stroke-width="1.6"/></g>'
    + '<path d="M17.6 4.4 l-4.6.6 4 4z" fill="#cbd5e1"/><path d="M20.6 7.4 l-4.6.6 4 4z" fill="#cbd5e1"/>'
    + '<path d="M4 18 l-.6-3.4 M4 18 l3.4.6 M7 21 l-.6-3.4 M7 21 l3.4.6" stroke="#f1f5f9" stroke-width="1.2"/></svg>',
};

// kind: 'weapon' | 'tool' | 'light' | 'throwable' | 'worn' — what it will be once it does something.
// tier: 0 = ordinary. A better version of an item is another entry with a higher tier.
// ⭐ `make` (2026-10-08) = what making one costs, in the inventory window's Make tab: `mats` [[materialId, n], …] and
// `prima`. Checked and taken by the server (`inv-make`); the client only shows it.
// ⭐ `light`: an item of kind 'light' IS a torch to the client — it is held, burns, lights and sets things alight
// (`scratchpad/weapons_ideas.md`, the torch decisions). The stand-in torch behaves as one too, for testing.
const ITEMS = {
  torch:       { name: 'Torch',           kind: 'light',     tier: 0, svg: SVG.torch, make: { mats: [[28, 1]], prima: 20 } },   // 28 = Wood
  test_sword:  { name: 'Stand-in sword',  kind: 'weapon',    tier: 0, svg: SVG.sword,  test: 1 },
  test_torch:  { name: 'Stand-in torch',  kind: 'light',     tier: 0, svg: SVG.torch,  test: 1 },
  test_arrows: { name: 'Stand-in arrows', kind: 'throwable', tier: 0, svg: SVG.arrows, test: 1 },
};

// What the debug panel's "give me stand-in items" hands out. Counts chosen so one is single and two are stacks.
const TEST_GIFT = [['test_sword', 1], ['test_torch', 3], ['test_arrows', 24]];

const isItem = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, id);

// The wire shape of the table: [[id, { name, kind, tier, svg }], …]. Sent once per socket.
function itemDefsWire() {
  return Object.keys(ITEMS).map(id => [id, { name: ITEMS[id].name, kind: ITEMS[id].kind, tier: ITEMS[id].tier | 0, svg: ITEMS[id].svg,
    make: ITEMS[id].make || null }]);
}

module.exports = { ITEMS, TEST_GIFT, isItem, itemDefsWire };
