// ============================================================================
// avatar-sim.js — SHARED authoritative avatar simulation (single source of truth)
//
// This exact file runs in TWO places:
//   • server/index.js requires it (authoritative simulation)
//   • the extension bundle inlines it verbatim (build.js prepends it to
//     content_script.js) so the client's prediction is byte-identical.
//
// DETERMINISM IS THE WHOLE POINT. Do not branch on environment, wall-clock,
// Math.random, or anything that differs between server and client. One fixed
// timestep = one call to stepMovement(). Keep it pure.
// ============================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root || (typeof self !== 'undefined' ? self : globalThis)).MWSim = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---- Constants (mirror of the client's avatar constants) ----
  const C = {
    STAGE_W: 1280, STAGE_H: 720, WORLD_W: 15360, WORLD_H: 3240,
    BLOB_R: 20, AV_W: 40, AV_H: 40,
    GRAVITY_BASE: 0.62, GRAVITY_UP_MULT: 0.88, GRAVITY_DOWN_MULT: 1.58,
    GRAVITY_APEX_MULT: 0.68, APEX_VY_THRESH: 0.38,
    JUMP_VY: -14, MAX_VY: 22,
    ACCEL: 0.75, DECEL: 0.68, MAX_VX: 5.0,
    // ⭐ WHAT BODY SIZE COSTS AND BUYS. Exponents on the size multiplier, so one number covers the whole range
    // instead of a table: "as you get larger you move slower and can't jump as high, and vice versa".
    // ⚠️ THEY LIVE HERE, NOT IN THE CLIENT'S `moveCfg`, and that is not a filing decision — this file runs on
    // both machines and must produce identical numbers from identical state. A debug dial the client could
    // change would be a sim that disagrees with the server about how fast you are.
    // ⚠️ AND THEY ARE CLAMPED, which matters far more since the range widened to 1..11 cells (0.2..2.2).
    // An exponent tuned across 0.6..1.4 does not stay sane over 0.2..2.2: at 0.2 the raw speed curve gives
    // 2.24× walk pace — a body that outruns its own DASH, which is not a small avatar, it is a broken one.
    // The curve is what was played and liked in the middle; the clamps are what stop the new extremes running
    // away, so the ends saturate instead.
    // ⚠️ Jump softened -0.35 → -0.22 on play ("maybe a little too high on the jump on the small side").
    // ⚠️ THE CEILINGS CAME DOWN AGAIN ON PLAY ("the speed and jump increase is a little too high when small").
    // Deliberately as CLAMPS rather than as gentler exponents: 3 cells — 1.29× speed, 1.12× jump — is the
    // reading the user played and approved, and softening the curve would move that too. The clamp only bites
    // at the small end, so what was liked is untouched and the extreme stops overshooting it.
    SIZE_SPEED_POW: -0.5,
    SIZE_JUMP_POW: -0.22,
    SIZE_SPEED_MIN: 0.7, SIZE_SPEED_MAX: 1.32,
    SIZE_JUMP_MIN: 0.82, SIZE_JUMP_MAX: 1.13,
    AIR_ACCEL: 0.52, AIR_DECEL: 0.985,
    COYOTE_FRAMES: 7, JUMP_BUFFER_FRAMES: 10,
    WALL_SLIDE_VY: 1.5, WALL_SLIDE_VY_FAST: 6,   // hold ↓ on a wall to slide down faster
    // Interactions
    GRAB_RANGE: 72,        // BLOB_R * 3.6
    THROW_VX: 9, THROW_VY: -9,
    CARRY_DX: 22,          // BLOB_R * 1.1
    CARRY_DY: 38,          // BLOB_R * 1.9
    PUSH_SPEED_MIN: 3.0,
    // (magic 15c) spider climb: up a wall, down a wall, along a ceiling — px a step (× the body's `speedMul`)
    CLIMB_VY: 2.6, CLIMB_DOWN_VY: 3.2, CLIMB_VX: 2.8,
    CLIMB_LIP: 0.65,   // (round 5) a bump this much of the body tall, or less, is stepped over on a floor, a wall or a ceiling (3 cells for a body of 5)
    TICK_HZ: 60,           // simulation rate
    SNAPSHOT_HZ: 30        // broadcast rate
  };

  // ---- Stage layouts (must match the client's STAGE_LAYOUTS exactly) ----
  // Stage 6: the built-in floating platforms were removed — players build their own with the
  // hotbar Platform tool. Only the ground floor remains so there's footing at spawn. (Three
  // identical entries are kept so layoutIndex/urlHash callers still resolve.)
  // ⚠️ ALL THREE MUST SPAN THE FULL WORLD_W. Entry [2] was left at the old 5120 when the world widened to 15360
  // (Stage 6) and [0]/[1] were updated — so on the ~1/3 of URLs whose hash picks it, the world floor stopped at
  // x=5120 and the BEDROCK BAND (drawPlatform's avBgMode-3 render of this platform) simply was not there for the
  // remaining two thirds of the world. Reported as "the bedrock is visually missing" on 2026-07-31; the comment
  // above already claimed the three were identical, so this restores the stated intent rather than changing it.
  const STAGE_LAYOUTS = [
    [ { x: 0, y: 648, w: 15360, h: 70 } ],
    [ { x: 0, y: 648, w: 15360, h: 70 } ],
    [ { x: 0, y: 648, w: 15360, h: 70 } ]
  ];

  // Stage 6 — taller world for building. Shift each authored 720-tall layout down so
  // its floor sits at the bottom of WORLD_H and the original platform arrangement sits
  // just above it; the large vertical space ABOVE is left open as building canvas.
  const V_SHIFT = C.WORLD_H - C.STAGE_H;
  for (const layout of STAGE_LAYOUTS) for (const p of layout) p.y += V_SHIFT;

  // URL → deterministic layout index (matches the client's urlHash)
  function layoutIndex(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) & 0xFFFF;
    return h % STAGE_LAYOUTS.length;
  }
  function platformsFor(url) { return STAGE_LAYOUTS[layoutIndex(url)]; }
  // ⚠️ THE OVERWORLD HAS NO PLATFORMS AT ALL — its ground is entirely generated terrain, so `PLATFORMS` is an
  // empty array there and `P[0].y` is a TypeError. The fallback is the world floor, which is the same thing the
  // page layout's entry [0] is.
  function floorY(P, fallback) { return (P && P.length) ? P[0].y : (fallback != null ? fallback : C.WORLD_H); }

  // ══ THE WORLD'S BOUNDS ARE PER-AVATAR, NOT A MODULE CONSTANT ═══════════════════════════════════════════════
  // 🟥 THIS IS WHAT MADE THE OVERWORLD INVISIBLE, and it is the same bug family as SIZE_PRESETS / FLOOR_TOP /
  // PLATFORMS: a PAGE-world constant on the Overworld path. `C.WORLD_W/H` are the page stage's 15,360 x 3,240.
  // The server spawned the avatar correctly at (1271548, 17112) — measured, the join line agreed — and then the
  // very first sim step clamped it to (15340, 3240), i.e. `WORLD_W - AV_W/2` and `WORLD_H` exactly. That single
  // clamp produced ALL FOUR reported symptoms at once:
  //   · `y > WORLD_H ⇒ y = WORLD_H, onGround = true`  → "all movement is along a flat ground" (an invisible floor)
  //   · `x + AV_W/2 > WORLD_W ⇒ x = WORLD_W - AV_W/2` → "an invisible wall on the right, but I can move left"
  //   · and it parks you at row 405 of a 4,096-row world, ~1,700 rows above any generated ground → nothing to see.
  // The terrain window was tracking correctly the whole time; it was faithfully following a body that had been
  // teleported into the corner of a world that is not the one it is in.
  // ⚠️ DETERMINISM IS PRESERVED: the bounds live on the STATE, which both ends already agree on, and they default
  // to `C.WORLD_W/H` when unset — so every page room, and every existing caller, behaves exactly as before.
  function boundsW(s) { return (s && s.worldW > 0) ? s.worldW : C.WORLD_W; }
  function boundsH(s) { return (s && s.worldH > 0) ? s.worldH : C.WORLD_H; }
  // The one seam callers use to tell an avatar which world it is standing in. Both ends must pass the SAME pair,
  // which is why it comes off the room shape the server sends on `avt-joined {dims}` and not off a local guess.
  function setBounds(s, w, h) { if (!s) return s; if (w > 0) s.worldW = w; if (h > 0) s.worldH = h; return s; }

  // ---- State ----
  function createState(id, P, worldW, worldH) {
    const ww = worldW > 0 ? worldW : C.WORLD_W, wh = worldH > 0 ? worldH : C.WORLD_H;
    return {
      id,
      worldW: ww, worldH: wh,
      x: ww / 2, y: floorY(P, wh),
      vx: 0, vy: 0,
      facingLeft: false, onGround: false, wasOnGround: false,
      hasDoubleJump: true, wallSlideDir: 0,
      coyote: 0, jumpBuffer: 0, fallThroughIdx: -1,
      grabbing: null, grabbedBy: null,
      noCollideId: null, noCollideTicks: 0,   // post-throw collision grace
      // ⭐ BODY SIZE, as a multiplier of the default (1 = the 40px body every avatar used to be). It is part of
      // the SIM STATE and not a client-side cosmetic, because it changes the collision box, the walk speed, the
      // jump and how far a shove moves you — all of which two machines have to agree about or prediction and
      // authority drift apart. Defaults to 1, so a state that never sets it behaves exactly as before.
      // ⚠️ Everything below reads `sizeOf(s)`, never `s.sizeK` directly, so an OLD state object arriving from
      // anywhere (an un-migrated snapshot, a peer on a previous build) is a full-size body rather than a
      // zero-size one — which would be a body that fits through nothing and collides with no one.
      sizeK: 1,
      // input edge memory
      prevJump: false, prevDown: false, prevRespawn: false, prevGrab: false,
      grab: false,        // latest grab-held flag (consumed by resolveGrabThrow)
      lastSeq: 0
    };
  }

  // ---- Body size ----
  // ⭐ ONE READER FOR THE WHOLE FILE. Clamped rather than trusted: `sizeK` arrives from a client packet on the
  // relay, and a body of size 0 (or 40) is not a small avatar, it is a hole in every collision test here.
  // ⚠️ THE BOUNDS MUST MATCH THE CLIENT'S SIZE RANGE. 2..11 cells of 8px against a 40px default is 0.4..2.2.
  // (2026-11-29) up to 4 (20 cells): GROW with bigger pieces grows past the old most (2.2 = 11 cells) — a safety stop, not a size anything aims for
  //   (the user: 30 cells lagged and the feet went wrong — 20 for now)
  function sizeOf(s) { const k = (s && s.sizeK) || 1; return k < 0.4 ? 0.4 : (k > 4 ? 4 : k); }
  const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
  function bodyW(s) { return C.AV_W * sizeOf(s); }
  function bodyH(s) { return C.AV_H * sizeOf(s); }
  function bodyR(s) { return C.BLOB_R * sizeOf(s); }
  // ⚠️ MASS GOES AS THE SQUARE, not as the radius — these are discs, and "bigger shoves smaller" only reads
  // right if the difference is more than linear. A 7-cell blob is 5.4× the mass of a 3-cell one, so a collision
  // between them moves the small one almost all of the way, which is what the report asked for at both ends
  // ("bigger… launch less far", "smaller… get launched further").
  function massOf(s) { const k = sizeOf(s); return k * k; }
  // `speedMul` / `jumpMul` — optional per-body multipliers (#176: stone skin, spring boots). Absent = 1, so every
  // body that has never heard of them runs and jumps exactly as before.
  function maxVxOf(s) { return C.MAX_VX * clamp(Math.pow(sizeOf(s), C.SIZE_SPEED_POW), C.SIZE_SPEED_MIN, C.SIZE_SPEED_MAX) * (s.speedMul || 1); }
  function jumpVyOf(s) { return C.JUMP_VY * clamp(Math.pow(sizeOf(s), C.SIZE_JUMP_POW), C.SIZE_JUMP_MIN, C.SIZE_JUMP_MAX) * (s.jumpMul || 1); }

  // ---- Platform + bounds collision (mirror of client resolveStage*) ----
  function resolveStageCollisions(s, P) {
    s.onGround = false;
    if (s.fallThroughIdx >= 0 && (s.y - bodyH(s)) > P[s.fallThroughIdx].y + P[s.fallThroughIdx].h) s.fallThroughIdx = -1;
    for (let i = 0; i < P.length; i++) {
      if (i === s.fallThroughIdx) continue;
      const p = P[i];
      const hw = bodyW(s) / 2;
      const al = s.x - hw, ar = s.x + hw;
      const at = s.y - bodyH(s), ab = s.y;
      if (ar <= p.x || al >= p.x + p.w || ab <= p.y || at >= p.y + p.h) continue;
      const oTop = ab - p.y, oBot = (p.y + p.h) - at;
      if (s.vy >= 0 && oTop < oBot) { s.y -= oTop; s.vy = 0; s.onGround = true; break; }
    }
  }
  function resolveStageBounds(s) {
    const WW = boundsW(s), WH = boundsH(s), hw = bodyW(s) / 2, bh = bodyH(s);
    if (s.x - hw < 0) {
      s.x = hw; s.vx = 0;
      if (!s.onGround && s.vy > 0) s.wallSlideDir = -1;
    }
    if (s.x + hw > WW) {
      s.x = WW - hw; s.vx = 0;
      if (!s.onGround && s.vy > 0) s.wallSlideDir = 1;
    }
    if (s.y - bh < 0) { s.y = bh; if (s.vy < 0) s.vy = 0; }
    if (s.y > WH) { s.y = WH; s.vy = 0; s.onGround = true; }
  }

  // ---- One fixed-timestep movement step for a single avatar ----
  // input: { seq, left, right, down, jump, grab, respawn } (all booleans)
  // Grabbed avatars are pinned elsewhere; do not step them.
  function stepMovement(s, input, P) {
    s.grab = !!input.grab; // stored for resolveGrabThrow's edge detection

    const inputX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const wantsDown = !!input.down;

    // Respawn (edge) — to the active checkpoint if one is set, else world spawn.
    // respawnX/Y are set out-of-sim (server: avatar-checkpoint handler; client: checkpoint touch).
    if (input.respawn && !s.prevRespawn) {
      s.x = (typeof s.respawnX === 'number') ? s.respawnX : boundsW(s) / 2;
      s.y = (typeof s.respawnY === 'number') ? s.respawnY : floorY(P, boundsH(s));
      s.vx = 0; s.vy = 0;
      s.hasDoubleJump = true; s.fallThroughIdx = -1; s.wallSlideDir = 0;
    }

    // Jump buffer (edge)
    if (input.jump && !s.prevJump) s.jumpBuffer = C.JUMP_BUFFER_FRAMES;

    // Wall slide persistence
    if (s.wallSlideDir !== 0) {
      if (s.onGround || s.vy < 0) {
        s.wallSlideDir = 0;
      } else {
        s.x = s.wallSlideDir === -1 ? bodyW(s) / 2 : boundsW(s) - bodyW(s) / 2;
        s.vx = 0; s.vy = Math.min(s.vy, wantsDown ? C.WALL_SLIDE_VY_FAST : C.WALL_SLIDE_VY);
      }
    }

    const canJump = s.onGround || s.coyote > 0;
    const canDoubleJump = !canJump && s.hasDoubleJump && s.wallSlideDir === 0;
    const canWallJump = s.wallSlideDir !== 0 && !s.onGround;

    if (s.jumpBuffer > 0) {
      if (wantsDown && s.onGround) {
        let onIdx = -1;
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          if (Math.abs(s.y - p.y) <= 3 && s.x + bodyW(s) / 2 > p.x && s.x - bodyW(s) / 2 < p.x + p.w) { onIdx = i; break; }
        }
        // index 0 is the canonical ground floor (floorY = P[0].y) — always solid, never droppable.
        if (onIdx > 0 && P[onIdx].y + P[onIdx].h < boundsH(s)) { s.fallThroughIdx = onIdx; s.vy = 5; }
        s.jumpBuffer = 0; s.coyote = 0;
      } else if (canWallJump) {
        s.vy = jumpVyOf(s); s.vx = -s.wallSlideDir * maxVxOf(s) * 1.4;
        s.facingLeft = s.wallSlideDir > 0; s.hasDoubleJump = true;
        s.wallSlideDir = 0; s.jumpBuffer = 0; s.coyote = 0;
      } else if (canJump) {
        s.vy = jumpVyOf(s); s.jumpBuffer = 0; s.coyote = 0;
      } else if (canDoubleJump) {
        s.vy = jumpVyOf(s) * 0.78; s.hasDoubleJump = false; s.jumpBuffer = 0;
      }
    }

    // Horizontal
    if (inputX !== 0) {
      if (s.onGround && Math.sign(inputX) !== Math.sign(s.vx) && Math.abs(s.vx) > 1.0) s.vx *= 0.40;
      const accel = s.onGround ? C.ACCEL : C.AIR_ACCEL;
      s.vx += inputX * accel;
      const mvx = maxVxOf(s);
      s.vx = Math.max(-mvx, Math.min(mvx, s.vx));
    } else {
      s.vx *= s.onGround ? C.DECEL : C.AIR_DECEL;
      if (Math.abs(s.vx) < 0.05) s.vx = 0;
    }
    if (s.vx < -0.3 && !s.facingLeft) s.facingLeft = true;
    if (s.vx > 0.3 && s.facingLeft) s.facingLeft = false;

    // Gravity (asymmetric)
    const prevVy = s.vy;
    const isApex = !s.onGround && Math.abs(s.vy) < C.APEX_VY_THRESH;
    const gMult = isApex ? C.GRAVITY_APEX_MULT : (s.vy < 0 ? C.GRAVITY_UP_MULT : C.GRAVITY_DOWN_MULT);
    s.vy = Math.min(s.vy + C.GRAVITY_BASE * gMult, C.MAX_VY);

    // Integrate + collide
    s.x += s.vx; s.y += s.vy;
    resolveStageCollisions(s, P);
    resolveStageBounds(s);

    // Landing / coyote / buffer bookkeeping
    const wasOnGround = s.wasOnGround;
    if (!wasOnGround && s.onGround) { s.hasDoubleJump = true; s.wallSlideDir = 0; }
    if (!s.onGround && wasOnGround && prevVy >= 0) s.coyote = C.COYOTE_FRAMES;
    else if (s.onGround) s.coyote = 0;
    else s.coyote = Math.max(0, s.coyote - 1);
    if (s.jumpBuffer > 0) s.jumpBuffer--;
    s.wasOnGround = s.onGround;

    // Variable jump height: releasing jump while rising cuts upward velocity
    if (!input.jump && s.prevJump && s.vy < 0) s.vy *= 0.45;

    // Decay post-throw collision grace
    if (s.noCollideTicks > 0) { s.noCollideTicks--; if (s.noCollideTicks === 0) s.noCollideId = null; }

    // Edge memory
    s.prevJump = !!input.jump;
    s.prevDown = wantsDown;
    s.prevRespawn = !!input.respawn;
    if (input.seq != null) s.lastSeq = input.seq;
  }

  // ---- ⭐ CLIMBING (magic 15c, 2026-11-25 — SPIDER CLIMB): clinging to walls AND ceilings ----
  // Called right AFTER `stepMovement` (which has already applied gravity and moved the body) and BEFORE the terrain collision pass, which
  // then resolves the move this sets — as the gas float does on the client. It REPLACES this step's velocity (and the move already made by
  // it) while the body clings. `solidAt(x, y)` -> bool is injected, as in `resolveOwnCollision`, so this file stays terrain-agnostic; the
  // world's edges count as walls here too. `on` = the body may climb this step (the caller's power and its exclusions).
  // THE RULE (the user, 2026-11-25): on a WALL — touch it in the air or push into it on the ground and you stick (no slide, no fall);
  // toward the wall climbs up, down climbs down, nothing hangs, the away key lets go, a fresh jump wall-jumps off it; climbing past its top
  // throws you up and over the lip. On a CEILING — reach it rising (or holding jump) and you stick; left / right crawl along it, down
  // drops you. In a corner both hold. State on the body: `climbW` (-1 left wall · 1 right · 0), `climbC` (on a ceiling), `climbCool`
  // (steps before it may cling again), `climbPJ` (the jump key last step — `prevJump` is already this step's by now).
  function climbStep(s, input, solidAt, on) {
    const pj = !!s.climbPJ; s.climbPJ = !!input.jump;
    if (s.climbCool > 0) s.climbCool--;
    if (!on || s.grabbedBy) { s.climbW = 0; s.climbC = false; return 0; }
    const hw = bodyW(s) / 2, bh = bodyH(s), m = 3, WW = boundsW(s);
    const sol = (x, y) => x < 0 || x > WW || !!solidAt(x, y);
    const side = (d) => { let n = 0; const x = s.x + d * (hw + m); for (const f of [0.22, 0.52, 0.82]) if (sol(x, s.y - bh * f)) n++; return n; };
    const nL = side(-1), nR = side(1);
    let nC = 0; for (const f of [-0.6, 0, 0.6]) if (sol(s.x + hw * f, s.y - bh - m)) nC++;
    const L = !!input.left, R = !!input.right, D = !!input.down, J = !!input.jump, fresh = J && !pj;
    const cool = s.climbCool > 0;
    // ── the wall: kept while it is there, taken in the air or by pushing into it
    let w = s.climbW || 0;
    if (w && (w < 0 ? nL : nR) < 2) {
      // past its top while climbing: up and over the lip
      if ((w < 0 ? L : R) && s.vy <= 0 && !nC) { s.vy = Math.min(s.vy, -5.5); s.vx = w * 2.5; }
      w = 0;
    }
    if (w && (w < 0 ? R : L)) { w = 0; s.climbCool = 6; }
    if (!w && !cool) {
      if (nL >= 2 && (L || !s.onGround) && !R) w = -1;
      else if (nR >= 2 && (R || !s.onGround) && !L) w = 1;
      if (w && s.onGround && !(w < 0 ? L : R)) w = 0;
    }
    // ── the ceiling
    let c = !!s.climbC;
    if (c && nC < 2) c = false;
    if (c && D && !w) { c = false; s.climbCool = 10; }
    if (!c && !cool && nC >= 2 && !s.onGround && (s.vy <= 0.5 || J || w)) c = true;
    // ── a wall-jump off a wall (never off the ceiling alone)
    if (w && fresh && !s.onGround) {
      s.vy = jumpVyOf(s); s.vx = -w * maxVxOf(s) * 1.4; s.facingLeft = w > 0; s.hasDoubleJump = true;
      s.climbW = 0; s.climbC = false; s.climbCool = 12; s.jumpBuffer = 0; return 0;
    }
    s.climbW = w; s.climbC = c;
    if (!w && !c) return 0;
    const k = s.speedMul || 1, upV = C.CLIMB_VY * k, dnV = C.CLIMB_DOWN_VY * k, xV = C.CLIMB_VX * k;
    // what this step's move should have been, put in place of the one `stepMovement` made
    let vx, vy;
    if (w) {
      vy = (w < 0 ? L : R) ? -upV : D ? dnV : 0;
      if (c && vy < 0) vy = 0;
      vx = c ? ((w < 0 ? R : L) ? -w * xV : w * 0.8) : w * 0.8;   // pressed into the wall so the collision keeps it flush
      s.facingLeft = w < 0;
    } else {
      vy = 0;                                                      // held where it is (pressing up into the rock read as a low ceiling: the body squashed)
      vx = L ? -xV : R ? xV : 0;
      if (vx) s.facingLeft = vx < 0;
    }
    s.x += vx - s.vx; s.y += vy - s.vy; s.vx = vx; s.vy = vy;
    s.onGround = false; s.coyote = 0; s.jumpBuffer = 0; s.hasDoubleJump = true; s.wallSlideDir = 0;
    return w ? (c ? 3 : 1) : 2;
  }

  // ---- ⭐ CLIMBING, ROUND 2 (magic 15c round 2, 2026-11-25 — the user: the controls "don't really work in a nice way", holding → into a right-hand wall walked
  // you up it, a jump could not stick to a ceiling, corners threw you off) ----
  // THE KEYS ARE SCREEN DIRECTIONS (as wall-walking games re-map the controls onto the surface): on a wall ↑ (W) climbs, ↓ goes down; on a ceiling ← → crawl;
  // on the floor you walk as ever. Straight INTO the surface does nothing; straight AWAY lets go (← on a right-hand wall, ↓ on a ceiling). While you cling
  // only SPACE jumps — off a wall away from it, off a ceiling downwards — so ↑ / W climb instead (on open ground they jump as ever). INSIDE corners: you hold
  // both surfaces. OUTSIDE corners (a wall's top or foot, a ceiling's end, a floor's edge with ↓): you swing round the edge on an arc about it.
  // `mode` 1 = STOP at an outside edge until you press the new way round · 2 = CARRY: the key you hold takes you round, and goes on meaning the same way
  // round on the new surface (`climbLatch`) until you let go of it.
  // `climbKeys` runs BEFORE `stepMovement` (what the keys mean this step — so the sim's walking and jumping see the same), `climbStep2` AFTER it, before the
  // terrain pass (as `climbStep`). keys: { up: ↑ / W held (not Space), leap: Space held }.
  const climbCnt = (A) => (A[0] ? 1 : 0) + (A[1] ? 1 : 0) + (A[2] ? 1 : 0);
  function climbSol(s, solidAt) { const WW = boundsW(s); return (x, y) => x < 0 || x > WW || !!solidAt(x, y); }
  // [by the feet, the middle, the head] on side `d`, `mg` px out from the body
  //   (round 8) `band`: side rock at or below this y is a STEP, not a wall (`climbBand`)
  function climbSide(s, sol, d, mg, band) { const hw = bodyW(s) / 2, bh = bodyH(s), x = s.x + d * (hw + mg), B = band == null ? Infinity : band, at = (y) => y < B && sol(x, y);
    return [at(s.y - bh * 0.22), at(s.y - bh * 0.52), at(s.y - bh * 0.82)]; }
  // ⭐ (round 8, the user: 'zipping' — pulled sideways onto cells, even 1-cell walls, skipping the floor between to zip to the next one; the body hanging sideways off a low
  //   wall) A FACE NO TALLER THAN A STEP-OVER IS A STEP, NEVER A WALL. Found offline (a floor of 1-cell lips): a falling body's feet dip into the floor before the terrain
  //   pass catches them, and the round-7 face grab — rock ANYWHERE along a pushed face, down to the foot line — took the FLOOR as a wall (and any lip at the feet); held
  //   still in the air the body never met the ground again, and the flush pull walked it across open air to the next lip. Side rock counts as a wall only ABOVE the step
  //   band: CLIMB_LIP of the body up from the ground under the feet, when there is ground within that far below (in the air everything counts). → { band, gap } (gap:
  //   the feet's height over that ground, Infinity with none)
  function climbBand(s, sol) { const hw = bodyW(s) / 2, bh = bodyH(s), lip = bh * C.CLIMB_LIP; let g = Infinity;
    for (const f of [-0.6, 0, 0.6]) { const x = s.x + hw * f; for (let y = s.y - 2; y <= s.y + lip; y += 2) if (sol(x, y)) { if (y < g) g = y; break; } }
    return g === Infinity ? { band: Infinity, gap: Infinity } : { band: g - lip, gap: g - s.y }; }
  function climbCeil(s, sol, mg) { const hw = bodyW(s) / 2, y = s.y - bodyH(s) - mg; let n = 0; for (const f of [-0.6, 0, 0.6]) if (sol(s.x + hw * f, y)) n++; return n; }
  // 🟥 (round 5, the user: 'if I'm on a surface and I press space, it does the flip jump and I can't do a second jump') round 4 SET `input.jump` from the raw Space key
  //   after the client's jump wind-up (16ze `limbsJumpWind`: a press crouches you, the jump goes off a moment later): the raw key jumped you at once and the wind-up's own
  //   jump then went off in the air — the double jump, the flip. Now the jump keys are only FILTERED, before the wind-up (the client calls this as the input is made): on a
  //   surface (the floor, a wall, a ceiling, mid-swing, carried round a corner) ↑ / W do not jump — they climb — and Space does; in the air every jump key jumps.
  function climbJumpKeys(s, input, keys, on) {
    if (!on || !input.jump) return;
    if ((s.onGround || s.climbW || s.climbC || s.climbWrap || s.climbLatch) && !(keys && keys.leap)) input.jump = false;
  }
  function climbKeys(s, input, keys, solidAt, on) {
    s.climbG = !!s.onGround;   // the ground as the last step left it (the sim's own step clears it before the terrain pass sets it again)
    if (!(keys && keys.leap)) s.climbLeapS = false;   // (round 8) the Space that leapt off a surface, let go (`climbLeapS`: no glide until then — the client's glide rule reads it)
    if (!on) { s.climbLatch = null; s.climbK = null; return; }
    const raw = { L: !!input.left, R: !!input.right, U: !!(keys && keys.up), D: !!input.down }, K = Object.assign({}, raw), La = s.climbLatch;
    if (La) { if (!raw[La.k]) s.climbLatch = null; else { K[La.k] = false; K[La.as] = true; } }
    // (round 3, the user: 'when you are in spider mode you cling to all surfaces … jumping with space could then be the thing that detaches you') only Space jumps
    // (round 5) while you CLING the sim's own jump is off — Space's leap off the surface is `climbStep2`'s (the sim's jump there spent your air jump: the flip, no second
    //   jump). What jumps on the floor is decided earlier, by `climbJumpKeys`.
    if (s.climbW || s.climbC || s.climbWrap) input.jump = false;
    input.left = K.L; input.right = K.R; input.down = K.D;
    s.climbK = { L: K.L, R: K.R, U: K.U, D: K.D, S: !!(keys && keys.leap) };
  }
  // start a swing round an outside corner at P: the body's middle from where it is now to `C1`, on an arc about P (bulged so the box's corner clears the rock)
  function climbWrapStart(s, sol, px, py, c1x, c1y, then) {
    const R = bodyR(s), cx = s.x, cy = s.y - R, q = R * 0.8;
    for (const [dx, dy] of [[0, 0], [q, 0], [-q, 0], [0, q], [0, -q]]) if (sol(c1x + dx, c1y + dy)) return false;
    const a0 = Math.atan2(cy - py, cx - px), a1r = Math.atan2(c1y - py, c1x - px); let da = a1r - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da <= -Math.PI) da += 2 * Math.PI;
    const r0 = Math.hypot(cx - px, cy - py), r1 = Math.hypot(c1x - px, c1y - py), am = a0 + da / 2, rm = (r0 + r1) / 2 + R * 0.45;
    if (sol(px + Math.cos(am) * rm, py + Math.sin(am) * rm)) return false;
    const k = s.speedMul || 1; s.climbWrap = Object.assign({ px, py, a0, da, r0, r1, R, t: 0, n: Math.max(6, Math.round(Math.PI / 2 * R / (C.CLIMB_VY * k))) }, then);
    return true;
  }
  // (round 5) open air from (x, y) for `len` px along (dx, dy)? — what tells a real edge from a notch, a bump or a step
  function climbOpen(sol, x, y, dx, dy, len) { for (let k = 0; k <= len; k += 4) if (sol(x + dx * k, y + dy * k)) return false; return true; }
  // …and over a whole box (the corners in any order): a body stepped OFF its surface (over a bump) sees only the bump with its probes — the surface it is really on is
  //   further out, inside this box
  function climbOpenBox(sol, xa, ya, xb, yb) { const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
    for (let x = x0; x <= x1 + 0.01; x += 4) for (let y = y0; y <= y1 + 0.01; y += 4) if (sol(x, y)) return false; return true; }
  // the body moving `t` (an axis: ±1, 0 / 0, ±1) along a surface whose 'up' is `n` (the same): rock in the way only in the band next to the surface, no taller than
  //   CLIMB_LIP of the body → stepped over (the body moved along `n` past it) · taller → 'blocked' (a real wall / an inside corner) · none → 'clear'
  function climbLip(s, sol, nx, ny, tx, ty, v) {
    const hw = bodyW(s) / 2, bh = bodyH(s), cx = s.x, cy = s.y - bh / 2, et = Math.abs(tx) * hw + Math.abs(ty) * bh / 2, en = Math.abs(nx) * hw + Math.abs(ny) * bh / 2, H = 2 * en, lip = Math.min(H - 4, H * C.CLIMB_LIP);
    const ax = cx + tx * (et + Math.abs(v) + 0.5) - nx * en, ay = cy + ty * (et + Math.abs(v) + 0.5) - ny * en; let top = -1;
    for (let h = 1; h < H - 1; h += 2) if (sol(ax + nx * h, ay + ny * h)) top = h;
    if (top < 0) return 'clear'; if (top > lip) return 'blocked';
    // the room past it: the body moved up by the bump must not be inside rock at its far side
    const up = top + 2; for (let h = H - 1; h <= H + up; h += 2) if (sol(cx + nx * (h - en), cy + ny * (h - en))) return 'blocked';
    s.x += nx * up; s.y += ny * up; return 'stepped';
  }
  // (round 7) an inside corner turns the key you are moving with onto the new surface: the key you are really holding (through any corner meaning it already has) now
  //   means `as`
  function climbTurn(s, kMapped, as) { const L0 = s.climbLatch, k = L0 && L0.as === kMapped ? L0.k : kMapped; if (k === as) { s.climbLatch = null; return; } s.climbLatch = { k, as }; }
  function climbStep2(s, solidAt, on, mode) {
    const K = s.climbK || { L: false, R: false, U: false, D: false, S: false }, fresh = K.S && !s.climbPJ; s.climbPJ = K.S;
    if (s.climbCool > 0) s.climbCool--;
    if (!on || s.grabbedBy) { s.climbW = 0; s.climbC = false; s.climbWrap = null; s.climbLatch = null; return 0; }
    const G = !!s.climbG, sol = climbSol(s, solidAt), R = bodyR(s), hw = bodyW(s) / 2, bh = bodyH(s), sk = s.speedMul || 1, upV = C.CLIMB_VY * sk, dnV = C.CLIMB_DOWN_VY * sk, xV = C.CLIMB_VX * sk;
    const put = (vx, vy) => { s.x += vx - s.vx; s.y += vy - s.vy; s.vx = vx; s.vy = vy; };
    const hold = () => { s.onGround = false; s.coyote = 0; s.jumpBuffer = 0; s.hasDoubleJump = true; s.wallSlideDir = 0; };
    // a swing begins where the body was before this step's own move (that move undone first); refused → as it was
    const tryWrap = (px, py, c1x, c1y, then) => { const ox = s.x, oy = s.y, ovx = s.vx, ovy = s.vy; put(0, 0);
      if (climbWrapStart(s, sol, px, py, c1x, c1y, then)) { s.climbW = 0; s.climbC = false; hold(); return true; } s.x = ox; s.y = oy; s.vx = ovx; s.vy = ovy; return false; };
    // ── swinging round an outside corner (the step it set the swing up, the body held still; then the arc; then the surface it comes to)
    const Wr = s.climbWrap;
    if (Wr) { Wr.t++; const u = Math.min(1, Wr.t / Wr.n), a = Wr.a0 + Wr.da * u, r = Wr.r0 + (Wr.r1 - Wr.r0) * u + Wr.R * 0.45 * Math.sin(Math.PI * u), cx = Wr.px + Math.cos(a) * r, cy = Wr.py + Math.sin(a) * r;
      s.vx = cx - s.x; s.vy = cy + Wr.R - s.y; s.x = cx; s.y = cy + Wr.R; hold();
      if (u >= 1) { s.climbWrap = null; s.climbW = Wr.w || 0; s.climbC = !!Wr.c; s.vx = 0; s.vy = 0; if (Wr.latch && mode === 2) { const L0 = s.climbLatch; s.climbLatch = { k: L0 && L0.as === Wr.latch.k ? L0.k : Wr.latch.k, as: Wr.latch.as }; } }   /* (a chain of corners: the key you are really holding goes on meaning the next way round) */
      return 4; }
    const sL = climbSide(s, sol, -1, 3), sR = climbSide(s, sol, 1, 3), nC = climbCeil(s, sol, 3);
    // (round 8) what is a WALL here: side rock above the step band (`climbBand`) — a lip at the feet, or the floor itself, never is. And a face is sampled short of the
    //   body's corners (±0.85): a wall flush beside the head is not a ceiling, the floor at the foot not a wall
    //   (near the ground the lower probes are in the band: one probe above it means rock taller than a step — a wall; in the air two, as before)
    const Bd = climbBand(s, sol), nL0 = climbCnt(climbSide(s, sol, -1, 3, Bd.band)), nR0 = climbCnt(climbSide(s, sol, 1, 3, Bd.band)), nB = Bd.band === Infinity ? 0 : 1,
      nL = nL0 ? nL0 + nB : 0, nR = nR0 ? nR0 + nB : 0, faceAt = (x, y, nx) => !(nx && y >= Bd.band) && sol(x, y);
    let w = s.climbW || 0, c = !!s.climbC; const was = (w ? 1 : 0) | (c ? 2 : 0);
    // (round 5) a hold is KEPT while rock is anywhere along that face within a step-over's height (`CLIMB_LIP`) — stepped down under a bump the body is that far off its
    //   ceiling, and dropping the hold there pulled it back up into the bump
    const nearF = (nx, ny, maxd) => { const ex = Math.abs(ny) * hw, ey = Math.abs(nx) * bh / 2, H = 2 * (Math.abs(nx) * hw + Math.abs(ny) * bh / 2);
      for (let dd = 1; dd <= maxd; dd += 3) { const ox = s.x - nx * (hw * Math.abs(nx) + dd), oy = s.y - bh / 2 - ny * (bh / 2 * Math.abs(ny) + dd);
        for (let q = -0.85; q <= 0.8501; q += 4 / Math.max(4, 2 * Math.max(ex, ey))) if (faceAt(ox + q * ex, oy + q * ey, nx)) return true; } return false; }, keepD = bh * 0.9;   /* (round 7: a slope leaning away outran 0.65 of the body — the cave hunt's falls) */
    if (w && (w < 0 ? nL : nR) === 0 && !nearF(-w, 0, keepD)) w = 0;
    if (c && nC === 0 && !nearF(0, 1, keepD)) c = false;
    // ── Space: off a wall away from it (a corner too), off a ceiling downwards
    // (round 8, the user: 'jump in the direction of the top of your head') straight out along the body's UP — away from what it grips (as it is drawn turned, 16zj
    //   `magicSpiderUp`): off a wall sideways, off a ceiling down, out of a corner between — at a jump's speed; the air jump kept
    if (fresh && (w || c)) {
      //   (the Space still held after it is never the glide — measured in the browser: falling with Space down the glide took the ceiling's leap to 2 px a step at once)
      const ux = w ? -w : 0, uy = c ? 1 : 0, ul = Math.hypot(ux, uy) || 1, J = Math.abs(jumpVyOf(s)); put(ux / ul * J, uy / ul * J); if (w) s.facingLeft = w > 0; s.climbLeapS = true;
      s.hasDoubleJump = true; s.climbW = 0; s.climbC = false; s.climbCool = 12; s.climbLatch = null; s.jumpBuffer = 0; s.prevJump = true; return 0;
    }
    // ── taking hold: in the air any wall or ceiling you touch (not a wall you press away from); on the ground, ↑ beside a wall
    const cool = s.climbCool > 0;
    // (round 7) …or rock ANYWHERE along the face you are pushing towards (a notch over a corner left only one of three probes on rock: the ceiling was never taken, and ↑
    //   pushed into it for ever — found by the offline cave hunt, `climb_bot.js`)
    //   — but already on another surface a face is taken only with rock along 40% of it (an outcrop touching a corner was taken as a ceiling / wall: a false corner)
    const fracF = (nx, ny) => { const ex = Math.abs(ny) * hw, ey = Math.abs(nx) * bh / 2, ox = s.x - nx * (hw * Math.abs(nx) + 2), oy = s.y - bh / 2 - ny * (bh / 2 * Math.abs(ny) + 2); let n = 0, k = 0;
      for (let q = -0.85; q <= 0.8501; q += 0.17) { k++; if (faceAt(ox + q * ex, oy + q * ey, nx)) n++; } return n / k; };
    const pushL = K.L || (s.vx < -0.5), pushR = K.R || (s.vx > 0.5), pushU = K.U || s.vy < -0.5 || !!w, onC = c, onW = !!w;
    if (!w && !cool) { if (!G) { if (nL >= 2 || (pushL && fracF(1, 0) >= (onC ? 0.4 : 0.01))) w = -1; else if (nR >= 2 || (pushR && fracF(-1, 0) >= (onC ? 0.4 : 0.01))) w = 1; } else if (K.U) { if (nL >= 2) w = -1; else if (nR >= 2) w = 1; } }
    let tookC = false; if (!c && !cool && !G && (nC >= 2 || (pushU && fracF(0, 1) >= (onW ? 0.4 : 0.01)))) { c = true; tookC = !(was & 2); }
    // ── letting go: straight away from the surface; on the ground a wall is let go unless you climb (you stand)
    // (round 3: nothing lets go but Space) in a corner the away key leaves the wall for the ceiling, ↓ the ceiling for the wall
    if (w && c && (w < 0 ? K.R : K.L)) w = 0;
    if (c && w && K.D) c = false;
    // ⭐ (round 7) A KEY CARRYING YOU ALWAYS MEANS A WAY ALONG WHAT YOU HOLD. The ways open from here: along the floor, along a wall, along a ceiling (never into one).
    //   A carried key whose meaning is not one of them — met an inside corner, or left pointing at or away from rock after a corner the probes saw late (found by the
    //   offline cave hunt) — turns to the open way nearest the way you were going (`climbMv`), never straight back: along a floor into a wall → up it, up a wall into a
    //   ceiling → along it, along a ceiling into a wall → down it, down a wall onto the floor → along the floor away from it.
    { const La = s.climbLatch; if (La) { const V = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] }, open = [];
        if (G || c) open.push('L', 'R'); if (w) open.push('U', 'D');
        const ok = (k) => open.includes(k) && !(k === 'D' && G) && !(k === 'U' && c) && !(k === 'L' && w < 0) && !(k === 'R' && w > 0);
        if (open.length && !ok(La.as)) { const mv = s.climbMv || V[La.as]; let best = null, bd = -1.5;
          for (const k of ['L', 'R', 'U', 'D']) { if (!ok(k)) continue; const d = V[k][0] * mv[0] + V[k][1] * mv[1]; if (d > -0.5 && d > bd) { bd = d; best = k; } }
          if (best) { if (best === La.k) s.climbLatch = null; else La.as = best; } } } }
    if (w && !c && G && !K.U) w = 0;   /* (round 8: a let-go with the ground just under the feet was tried — it made tight pockets flip between holds every step; the step band is the fix) */
    // ── outside corners
    let stopUp = false, stopDn = false, stopX = false;
    if (w && !c) { const S = w < 0 ? sL : sR, xf = s.x + w * hw, xin = xf + w * 1.5, cy = s.y - R, toward = w < 0 ? K.L : K.R;
      // its TOP: your middle past it, your feet still on it → up and over, onto it
      if (S[0] && !S[1] && !S[2] && !sol(xin, cy) && climbOpenBox(sol, xin, cy, xin + w * bh * C.CLIMB_LIP, s.y - bh - 4 - bh * C.CLIMB_LIP)) { const go = mode === 2 ? (K.U || toward) : toward;   /* (round 5: not a notch — the face does not come back above you) */
        if (go) { let yt = cy; while (yt < s.y && !sol(xin, yt)) yt += 1; if (tryWrap(xf, yt, xf + w * R * 0.6, yt - R - 1, { w: 0, c: false, face: w, latch: { k: 'U', as: w < 0 ? 'L' : 'R' } })) return 4; }
        if (K.U) stopUp = true; }   /* (round 4: a swing that will not fit holds you at the edge — it let you fall) */
      // its FOOT, over nothing: your middle below it, your head still on it → round under it, onto its underside
      if (!S[0] && !S[1] && S[2] && !G && !sol(s.x, s.y + 3) && !sol(xin, cy) && climbOpenBox(sol, xin, cy, xin + w * bh * C.CLIMB_LIP, s.y + 4 + bh * C.CLIMB_LIP)) { const go = mode === 2 ? (K.D || toward) : toward;   /* (round 5: not a notch) */
        if (go) { let yb = cy; while (yb > s.y - bh && !sol(xin, yb)) yb -= 1; yb += 1; if (tryWrap(xf, yb, xf + w * R * 0.6, yb + R + 1, { w: 0, c: true, face: w, latch: { k: 'D', as: w < 0 ? 'L' : 'R' } })) return 4; }
        if (K.D) stopDn = true; } }
    const d = K.L && !K.R ? -1 : K.R && !K.L ? 1 : 0;
    // (round 5, the user: a single missing cell in a flat ceiling stopped them dead) an END has rock on ONE side of your middle only and air on past it — a notch has rock
    //   both sides, and is crawled over
    if (c && !w) { const ya = s.y - bh - 1.5, rR = sol(s.x + hw * 0.6, ya), rL = sol(s.x - hw * 0.6, ya), e0 = sol(s.x, ya) || rR === rL ? 0 : rR ? -1 : 1, xe0 = (() => { let q = s.x; if (e0) while ((s.x - q) * e0 < hw && !sol(q, ya)) q -= e0; return q; })(), e = e0 && climbOpenBox(sol, xe0 + e0, ya, xe0 + e0 * (1 + hw * 1.2 + bh * C.CLIMB_LIP), ya - bh) ? e0 : 0;   /* (round 7: looked for from the rock's very edge — a ceiling stepping up just past it was read as its end) */   /* (a body's height of air past it, else it is a bump or a step: crawled past) */
      // a ceiling's END (`e`: the way past it): your middle past it → round its edge and up its outer face
      if (e) { const go = mode === 2 ? d === e : K.U;
        if (go) { let xe = s.x; while ((s.x - xe) * e < hw && !sol(xe, ya)) xe -= e; xe += e * 0.5; const yc = s.y - bh;
          if (tryWrap(xe, yc, xe + e * (R + 1), yc - R * 0.6, { w: -e, c: false, face: -e, latch: { k: e < 0 ? 'L' : 'R', as: 'U' } })) return 4; }
        if (d === e) stopX = true; } }
    // a floor's EDGE (a real drop, not a step in the ground): your middle over nothing → round its edge and down its outer face. (round 3, the user: 'no walking off
    //   edges … walk off an edge straight onto the wall'.) CARRY: as you walk off it, the key you walk with now meaning ↓ · STOP: held at the edge, ↓ takes you over
    if (!w && !c && G && !cool) { const yf = s.y + 2, l = sol(s.x - hw * 0.6, yf), r = sol(s.x + hw * 0.6, yf);
      if (!sol(s.x, yf) && l !== r) { const dir = l ? 1 : -1; let xs = s.x; while ((s.x - xs) * dir < hw && !sol(xs, yf)) xs -= dir;
        // (round 7) a step down no deeper than a step-over, from the very EDGE of what you stand on out past your front, is walked down (from your middle it missed a
        //   step just behind it, and the swing down past it would not fit — the offline cave hunt)
        const step = !climbOpenBox(sol, xs + dir * 2, s.y + 2, xs + dir * (2 + hw * 1.5 + bh * C.CLIMB_LIP), s.y + 2 + bh * C.CLIMB_LIP);
        if (!step) { const walk = dir < 0 ? K.L : K.R, go = mode === 2 ? !K.U : K.D; const edge = xs + dir, px = xs + dir * 0.5;
          if (go && tryWrap(px, s.y - 1, px + dir * (R + 1), s.y - 1 + R * 0.6, { w: -dir, c: false, face: -dir, latch: walk ? { k: dir < 0 ? 'L' : 'R', as: 'D' } : null })) return 4;
          // (STOP: held with your middle just over the edge — where the next step still sees it)
          const over = (s.x - edge) * dir; if (over > 0) { s.x -= dir * over; if (s.vx * dir > 0) s.vx = 0; } } } }
    // (round 3) lost every hold in mid-move (a notch, a slant of steps): rock within a few px is taken again before the body falls
    if (!w && !c && !G && was && !cool) { for (let mg = 4; mg <= 20 && !w && !c; mg++) { const fr = (dx, dy) => { const q = R * 0.8; for (const [ex, ey] of [[0, 0], [q, 0], [-q, 0], [0, q], [0, -q]]) if (sol(s.x + dx + ex, s.y - R + dy + ey)) return false; return true; };   /* (round 5: never into rock) */
      if (climbCnt(climbSide(s, sol, -1, mg, Bd.band)) >= 1 && fr(-(mg - 3), 0)) { s.x -= mg - 3; w = -1; } else if (climbCnt(climbSide(s, sol, 1, mg, Bd.band)) >= 1 && fr(mg - 3, 0)) { s.x += mg - 3; w = 1; } else if (climbCeil(s, sol, mg) >= 1 && fr(0, -(mg - 3))) { s.y -= mg - 3; c = true; } } }
    // (round 5) on the floor, walking into a bump: stepped up over it (the terrain pass only steps one cell)
    if (!w && !c && G && (K.L || K.R) && !(K.L && K.R)) s.climbMv = [K.L ? -1 : 1, 0];
    //   (round 8) …and the step's fall cleared as it lifts you: kept, it sank the body back into the step's face before it was over it, and it hopped there again and again
    //   (the false wall grab on that face had held it up — taken out above)
    if (!w && !c && G && (K.L || K.R) && !(K.L && K.R)) { const dd = K.L ? -1 : 1, lp = climbLip(s, sol, 0, -1, dd, 0, Math.abs(s.vx) + 1); if (lp === 'stepped') s.vy = Math.min(0, s.vy); if (lp === 'blocked' && mode === 2 && !cool) {
        // (mode 2) a wall met walking: up it, the key you walk with now meaning ↑
        w = dd; climbTurn(s, dd < 0 ? 'L' : 'R', 'U'); } }
    s.climbW = w; s.climbC = c;
    if (!w && !c) return 0;
    // ── moving along what you hold
    let vx, vy;
    if (w && c) { vx = 0; vy = 0; }
    else if (w) { vx = 0; vy = K.U ? -upV : K.D ? dnV : 0; if (stopUp && vy < 0) vy = 0; if (stopDn && vy > 0) vy = 0; }
    else { vy = 0; vx = d * xV; if (stopX) vx = 0; }
    // (round 5) a bump ahead on the wall or the ceiling: stepped over, away from the surface (a wall: across, a ceiling: down)
    if (w && !c && vy) { if (climbLip(s, sol, -w, 0, 0, Math.sign(vy), vy) === 'blocked') { if (mode !== 2) vy = 0; else if (vy < 0) { c = true; s.climbC = true; climbTurn(s, 'U', w < 0 ? 'R' : 'L'); vy = 0; } else climbTurn(s, 'D', w < 0 ? 'R' : 'L'); } }
    else if (c && !w && vx) { if (climbLip(s, sol, 0, 1, Math.sign(vx), 0, vx) === 'blocked') { if (mode !== 2) vx = 0; else { w = Math.sign(vx); s.climbW = w; climbTurn(s, vx < 0 ? 'L' : 'R', 'D'); vx = 0; } } }
    // (round 4) facing the way you go, in the body's OWN frame — it is drawn turned to its surface: on a wall on your left your left is up, on a ceiling your left is
    //   screen right
    if (w && !c) { if (vy) s.facingLeft = (vy < 0) === (w < 0); } else if (c && !w) { if (vx) s.facingLeft = vx > 0; } else if (vx) s.facingLeft = vx < 0;
    // a ceiling taken while rising: the step's rise is KEPT (the terrain pass stops the head at the rock) — undoing it left you below the reach of the next step
    if (tookC && s.vy < 0) { s.x += vx - s.vx; s.vx = vx; s.vy = 0; } else put(vx, vy);
    if (vx || vy) s.climbMv = [Math.sign(vx), Math.sign(vy)];
    // flush with the rock, up to 6 px (never pressed into it — that read as a low ceiling, and the body squashed)
    //   (round 5: tested along the WHOLE face, every 4 px — three points let it pull the body up into a bump it was passing under, which undid the step over it)
    const touch = (nx, ny) => { const ex = Math.abs(ny) * hw, ey = Math.abs(nx) * bh / 2, ox = s.x - nx * (hw + 1), oy = s.y - bh / 2 - ny * (bh / 2 + 1);
      for (let q = -1; q <= 1.0001; q += 4 / Math.max(4, 2 * Math.max(ex, ey))) if (faceAt(ox + q * ex, oy + q * ey, nx)) return true; return false; };
    if (c && !tookC) for (let i = 0; i < 10 && !touch(0, 1); i++) s.y -= 1;
    if (w) for (let i = 0; i < 10 && !touch(-w, 0); i++) s.x += w;   /* (round 7: up to 10 px a step — a face leaning away is followed) */
    hold();
    return w ? (c ? 3 : 1) : 2;
  }

  // ---- Grab / throw resolution + carried pinning (server-authoritative) ----
  function resolveGrabThrow(list, byId) {
    for (const s of list) {
      if (s.grab && !s.prevGrab) {
        if (s.grabbing) {
          const tgt = byId[s.grabbing];
          if (tgt) {
            const dir = s.facingLeft ? -1 : 1;
            tgt.vx = dir * C.THROW_VX + s.vx * 0.5;
            tgt.vy = C.THROW_VY;
            tgt.grabbedBy = null; tgt.hasDoubleJump = true;
            // Don't let the just-released victim immediately collide-shove the thrower.
            s.noCollideId = tgt.id; s.noCollideTicks = 15;
            tgt.noCollideId = s.id; tgt.noCollideTicks = 15;
          }
          s.grabbing = null;
        } else if (!s.grabbedBy) {
          let best = null, bestD = C.GRAB_RANGE;
          for (const o of list) {
            if (o.id === s.id || o.grabbedBy || o.grabbing) continue;
            const d = Math.hypot(s.x - o.x, s.y - o.y);
            if (d < bestD) { bestD = d; best = o; }
          }
          if (best) { s.grabbing = best.id; best.grabbedBy = s.id; }
        }
      }
      s.prevGrab = !!s.grab;
    }
    // Pin carried avatars above/in front of their grabber
    for (const s of list) {
      if (s.grabbedBy) {
        const g = byId[s.grabbedBy];
        if (!g || g.grabbing !== s.id) { s.grabbedBy = null; continue; }
        const dir = g.facingLeft ? -1 : 1;
        s.x = g.x + dir * C.CARRY_DX; s.y = g.y - C.CARRY_DY;
        s.vx = 0; s.vy = 0; s.onGround = false; s.facingLeft = g.facingLeft;
      }
    }
  }

  // ---- Avatar↔avatar collision (mutual separation + shove) ----
  function resolveCollisions(list, byId) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.grabbedBy || b.grabbedBy) continue;          // carried blobs don't collide
        if (a.grabbing === b.id || b.grabbing === a.id) continue;
        if ((a.noCollideId === b.id && a.noCollideTicks > 0) ||
            (b.noCollideId === a.id && b.noCollideTicks > 0)) continue;  // post-throw grace
        // ⭐ THE CONTACT DISTANCE IS THE PAIR'S, not a constant. `BLOB_R * 2.1` was two default bodies plus 5%
        // resting slack; written as the sum of the two radii it means the same thing for equal sizes and the
        // right thing for unequal ones.
        const minDist = (bodyR(a) + bodyR(b)) * 1.05;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minDist || dist <= 0.5) continue;
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        // ⭐ AND THE SEPARATION IS SHARED BY MASS. Equal sizes give 0.5/0.5, i.e. exactly the old behaviour;
        // a big body against a small one barely moves while the small one is shoved nearly the whole overlap.
        // (x more than y so a contact never launches anyone vertically — unchanged.)
        const ma = massOf(a), mb = massOf(b), sa = mb / (ma + mb), sb = ma / (ma + mb);
        a.x -= nx * overlap * sa; a.y -= ny * overlap * sa * 0.6;
        b.x += nx * overlap * sb; b.y += ny * overlap * sb * 0.6;
        // Exchange momentum along the contact normal when approaching = the shove
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const imp = -vn * 1.2;                           // ×2 of the old 0.6, since each side now takes its share
          a.vx -= nx * imp * sa; a.vy -= ny * imp * sa * 0.5;
          b.vx += nx * imp * sb; b.vy += ny * imp * sb * 0.5;
        }
      }
    }
  }

  // Client-side collision PREDICTION: resolve one avatar `s` against a set of fixed
  // obstacles, using the EXACT a-side math from resolveCollisions (half separation +
  // momentum exchange). Because it mirrors the server's own-side update, the predicting
  // client's trajectory matches authority → no pass-through, no reconciliation jitter.
  // obstacles: [{ id, x, y, vx, vy }] — usually the interpolated remote avatars.
  // `solidAt(x, y) -> bool` is OPTIONAL and asks whether a body with its feet at (x, y) is inside solid terrain.
  // 🟥 WHY A CALLBACK AND NOT A TERRAIN LOOKUP: this file is shared by the client and the server, and neither
  // holds terrain the same way (client = terrainGrid, server = chunked PagedArrays). Injecting the predicate
  // keeps the sim terrain-agnostic, which is the only reason it can be shared at all.
  // 🟥 WHY IT IS NEEDED: separation moves the body with NO velocity, and nothing downstream can undo a vertical
  // move — `depenetrate` resolves horizontally only, and the terrain landing scan requires a downward crossing
  // that a teleport never satisfies. So a shove of more than a few px into the floor is PERMANENT. Rather than
  // trying to repair that afterwards, refuse to make the move: an unresolved blob overlap is a cosmetic problem,
  // being inside the world is not.
  function resolveOwnCollision(s, obstacles, solidAt) {
    if (s.grabbedBy) return;
    const SLOP = 3;                                      // resting tolerance: don't correct tiny overlaps →
                                                        // kills the two-body feedback jitter when blobs touch
    // ⚠️ MY SHARE IS THE *OTHER* BODY'S MASS OVER THE TOTAL, exactly as in `resolveCollisions` above — and it
    // has to be, because this function IS that function's a-side, run on the predicting client. If the two
    // disagreed about how much of an overlap each body takes, every contact would reconcile.
    const myMass = massOf(s);
    for (const o of obstacles) {
      if (s.grabbing === o.id) continue;
      if (s.noCollideId === o.id && s.noCollideTicks > 0) continue;
      const minDist = (bodyR(s) + bodyR(o)) * 1.05;
      const share = massOf(o) / (myMass + massOf(o));
      const dx = o.x - s.x, dy = o.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist || dist <= 0.5) continue;
      const nx = dx / dist, ny = dy / dist, overlap = minDist - dist;
      if (overlap > SLOP) {
        const px = s.x, py = s.y;
        s.x -= nx * (overlap - SLOP) * share; s.y -= ny * (overlap - SLOP) * share * 0.6;
        // Only ever VETO a move that puts us somewhere bad; never veto one that was already bad (being nudged
        // while stuck must stay possible, or a blob buried by a terrain edit could never be pushed free).
        if (solidAt && solidAt(s.x, s.y) && !solidAt(px, py)) {
          s.y = py;                                      // vertical is the unrecoverable axis — drop it first
          if (solidAt(s.x, s.y)) s.x = px;               // still inside → abandon the separation entirely
        }
      }
      const ovx = o.vx || 0, ovy = o.vy || 0;
      const vn = (ovx - s.vx) * nx + (ovy - s.vy) * ny;
      if (vn < -0.6) { const imp = -vn * 1.2 * share; s.vx -= nx * imp; s.vy -= ny * imp * 0.5; } // ignore interpolation-jitter rel-vel; `share` = ×0.6 between equals, as before
    }
  }

  // Serialize the FULL reconcilable state for a snapshot entry. The owning client
  // resets to this and replays its unacked inputs (exact, deterministic). Other
  // clients only read x/y/facingLeft/onGround/grabbing/grabbedBy for rendering.
  function snapshot(s) {
    return {
      id: s.id, x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      facingLeft: s.facingLeft, onGround: s.onGround, wasOnGround: s.wasOnGround,
      hasDoubleJump: s.hasDoubleJump, wallSlideDir: s.wallSlideDir,
      coyote: s.coyote, jumpBuffer: s.jumpBuffer, fallThroughIdx: s.fallThroughIdx,
      grabbing: s.grabbing, grabbedBy: s.grabbedBy,
      noCollideId: s.noCollideId, noCollideTicks: s.noCollideTicks,
      prevJump: s.prevJump, prevDown: s.prevDown, prevGrab: s.prevGrab, prevRespawn: s.prevRespawn,
      sizeK: s.sizeK,
      seq: s.lastSeq
    };
  }

  // Apply a snapshot entry back onto a state object (client reconciliation).
  function applySnapshot(s, a) {
    s.x = a.x; s.y = a.y; s.vx = a.vx; s.vy = a.vy;
    s.facingLeft = a.facingLeft; s.onGround = a.onGround; s.wasOnGround = a.wasOnGround;
    s.hasDoubleJump = a.hasDoubleJump; s.wallSlideDir = a.wallSlideDir;
    s.coyote = a.coyote; s.jumpBuffer = a.jumpBuffer; s.fallThroughIdx = a.fallThroughIdx;
    s.grabbing = a.grabbing; s.grabbedBy = a.grabbedBy;
    s.noCollideId = a.noCollideId; s.noCollideTicks = a.noCollideTicks;
    s.prevJump = a.prevJump; s.prevDown = a.prevDown; s.prevGrab = a.prevGrab; s.prevRespawn = a.prevRespawn;
    // ⚠️ ONLY IF THE SNAPSHOT CARRIES ONE. Size is owned by the player, not by authority: the client sets it
    // and tells everyone. A snapshot from a server build that does not know about it would otherwise reset
    // you to full size on every reconciliation — a body that changes shape whenever a packet lands.
    if (a.sizeK != null) s.sizeK = a.sizeK;
    s.lastSeq = a.seq;
  }

  return {
    C, STAGE_LAYOUTS, layoutIndex, platformsFor, floorY, setBounds, boundsW, boundsH,
    createState, stepMovement, climbStep, climbKeys, climbJumpKeys, climbStep2, resolveGrabThrow, resolveCollisions, resolveOwnCollision, snapshot, applySnapshot,
    // ⭐ EXPORTED so the client asks THIS FILE what a body's dimensions are, rather than keeping a second
    // opinion. The clamp, the exponents and the mass law are physics and belong to the sim; a client that
    // computed its own would be the two-lists-of-materials bug in another costume.
    sizeOf, bodyW, bodyH, bodyR, massOf, maxVxOf, jumpVyOf
  };
});
