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
    // Over the shipped 0.6..1.4 range: speed runs 1.29× down to 0.85×, jump HEIGHT 1.42× down to 0.79×.
    SIZE_SPEED_POW: -0.5,
    SIZE_JUMP_POW: -0.35,
    AIR_ACCEL: 0.52, AIR_DECEL: 0.985,
    COYOTE_FRAMES: 7, JUMP_BUFFER_FRAMES: 10,
    WALL_SLIDE_VY: 1.5, WALL_SLIDE_VY_FAST: 6,   // hold ↓ on a wall to slide down faster
    // Interactions
    GRAB_RANGE: 72,        // BLOB_R * 3.6
    THROW_VX: 9, THROW_VY: -9,
    CARRY_DX: 22,          // BLOB_R * 1.1
    CARRY_DY: 38,          // BLOB_R * 1.9
    PUSH_SPEED_MIN: 3.0,
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
  // ⚠️ THE BOUNDS MUST MATCH THE CLIENT'S SIZE RANGE. 3..7 cells of 8px against a 40px default is 0.6..1.4.
  function sizeOf(s) { const k = (s && s.sizeK) || 1; return k < 0.6 ? 0.6 : (k > 1.4 ? 1.4 : k); }
  function bodyW(s) { return C.AV_W * sizeOf(s); }
  function bodyH(s) { return C.AV_H * sizeOf(s); }
  function bodyR(s) { return C.BLOB_R * sizeOf(s); }
  // ⚠️ MASS GOES AS THE SQUARE, not as the radius — these are discs, and "bigger shoves smaller" only reads
  // right if the difference is more than linear. A 7-cell blob is 5.4× the mass of a 3-cell one, so a collision
  // between them moves the small one almost all of the way, which is what the report asked for at both ends
  // ("bigger… launch less far", "smaller… get launched further").
  function massOf(s) { const k = sizeOf(s); return k * k; }
  function maxVxOf(s) { return C.MAX_VX * Math.pow(sizeOf(s), C.SIZE_SPEED_POW); }
  function jumpVyOf(s) { return C.JUMP_VY * Math.pow(sizeOf(s), C.SIZE_JUMP_POW); }

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
    createState, stepMovement, resolveGrabThrow, resolveCollisions, resolveOwnCollision, snapshot, applySnapshot,
    // ⭐ EXPORTED so the client asks THIS FILE what a body's dimensions are, rather than keeping a second
    // opinion. The clamp, the exponents and the mass law are physics and belong to the sim; a client that
    // computed its own would be the two-lists-of-materials bug in another costume.
    sizeOf, bodyW, bodyH, bodyR, massOf, maxVxOf, jumpVyOf
  };
});
