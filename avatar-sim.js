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
    STAGE_W: 1280, STAGE_H: 720, WORLD_W: 5120, WORLD_H: 2160,
    BLOB_R: 20, AV_W: 40, AV_H: 40,
    GRAVITY_BASE: 0.62, GRAVITY_UP_MULT: 0.88, GRAVITY_DOWN_MULT: 1.58,
    GRAVITY_APEX_MULT: 0.68, APEX_VY_THRESH: 0.38,
    JUMP_VY: -14, MAX_VY: 22,
    ACCEL: 0.75, DECEL: 0.68, MAX_VX: 5.0,
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
  const STAGE_LAYOUTS = [
    [ { x: 0, y: 648, w: 5120, h: 70 } ],
    [ { x: 0, y: 648, w: 5120, h: 70 } ],
    [ { x: 0, y: 648, w: 5120, h: 70 } ]
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
  function floorY(P) { return P[0].y; }

  // ---- State ----
  function createState(id, P) {
    return {
      id,
      x: C.WORLD_W / 2, y: floorY(P),
      vx: 0, vy: 0,
      facingLeft: false, onGround: false, wasOnGround: false,
      hasDoubleJump: true, wallSlideDir: 0,
      coyote: 0, jumpBuffer: 0, fallThroughIdx: -1,
      grabbing: null, grabbedBy: null,
      noCollideId: null, noCollideTicks: 0,   // post-throw collision grace
      // input edge memory
      prevJump: false, prevDown: false, prevRespawn: false, prevGrab: false,
      grab: false,        // latest grab-held flag (consumed by resolveGrabThrow)
      lastSeq: 0
    };
  }

  // ---- Platform + bounds collision (mirror of client resolveStage*) ----
  function resolveStageCollisions(s, P) {
    s.onGround = false;
    if (s.fallThroughIdx >= 0 && (s.y - C.AV_H) > P[s.fallThroughIdx].y + P[s.fallThroughIdx].h) s.fallThroughIdx = -1;
    for (let i = 0; i < P.length; i++) {
      if (i === s.fallThroughIdx) continue;
      const p = P[i];
      const al = s.x - C.AV_W / 2, ar = s.x + C.AV_W / 2;
      const at = s.y - C.AV_H, ab = s.y;
      if (ar <= p.x || al >= p.x + p.w || ab <= p.y || at >= p.y + p.h) continue;
      const oTop = ab - p.y, oBot = (p.y + p.h) - at;
      if (s.vy >= 0 && oTop < oBot) { s.y -= oTop; s.vy = 0; s.onGround = true; break; }
    }
  }
  function resolveStageBounds(s) {
    if (s.x - C.AV_W / 2 < 0) {
      s.x = C.AV_W / 2; s.vx = 0;
      if (!s.onGround && s.vy > 0) s.wallSlideDir = -1;
    }
    if (s.x + C.AV_W / 2 > C.WORLD_W) {
      s.x = C.WORLD_W - C.AV_W / 2; s.vx = 0;
      if (!s.onGround && s.vy > 0) s.wallSlideDir = 1;
    }
    if (s.y - C.AV_H < 0) { s.y = C.AV_H; if (s.vy < 0) s.vy = 0; }
    if (s.y > C.WORLD_H) { s.y = C.WORLD_H; s.vy = 0; s.onGround = true; }
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
      s.x = (typeof s.respawnX === 'number') ? s.respawnX : C.WORLD_W / 2;
      s.y = (typeof s.respawnY === 'number') ? s.respawnY : floorY(P);
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
        s.x = s.wallSlideDir === -1 ? C.AV_W / 2 : C.WORLD_W - C.AV_W / 2;
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
          if (Math.abs(s.y - p.y) <= 3 && s.x + C.AV_W / 2 > p.x && s.x - C.AV_W / 2 < p.x + p.w) { onIdx = i; break; }
        }
        // index 0 is the canonical ground floor (floorY = P[0].y) — always solid, never droppable.
        if (onIdx > 0 && P[onIdx].y + P[onIdx].h < C.WORLD_H) { s.fallThroughIdx = onIdx; s.vy = 5; }
        s.jumpBuffer = 0; s.coyote = 0;
      } else if (canWallJump) {
        s.vy = C.JUMP_VY; s.vx = -s.wallSlideDir * C.MAX_VX * 1.4;
        s.facingLeft = s.wallSlideDir > 0; s.hasDoubleJump = true;
        s.wallSlideDir = 0; s.jumpBuffer = 0; s.coyote = 0;
      } else if (canJump) {
        s.vy = C.JUMP_VY; s.jumpBuffer = 0; s.coyote = 0;
      } else if (canDoubleJump) {
        s.vy = C.JUMP_VY * 0.78; s.hasDoubleJump = false; s.jumpBuffer = 0;
      }
    }

    // Horizontal
    if (inputX !== 0) {
      if (s.onGround && Math.sign(inputX) !== Math.sign(s.vx) && Math.abs(s.vx) > 1.0) s.vx *= 0.40;
      const accel = s.onGround ? C.ACCEL : C.AIR_ACCEL;
      s.vx += inputX * accel;
      s.vx = Math.max(-C.MAX_VX, Math.min(C.MAX_VX, s.vx));
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
    const minDist = C.BLOB_R * 2.1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.grabbedBy || b.grabbedBy) continue;          // carried blobs don't collide
        if (a.grabbing === b.id || b.grabbing === a.id) continue;
        if ((a.noCollideId === b.id && a.noCollideTicks > 0) ||
            (b.noCollideId === a.id && b.noCollideTicks > 0)) continue;  // post-throw grace
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minDist || dist <= 0.5) continue;
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        // Separate both equally (x more than y so they don't launch vertically)
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.3;
        b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.3;
        // Exchange momentum along the contact normal when approaching = the shove
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const imp = -vn * 0.6;
          a.vx -= nx * imp; a.vy -= ny * imp * 0.5;
          b.vx += nx * imp; b.vy += ny * imp * 0.5;
        }
      }
    }
  }

  // Client-side collision PREDICTION: resolve one avatar `s` against a set of fixed
  // obstacles, using the EXACT a-side math from resolveCollisions (half separation +
  // momentum exchange). Because it mirrors the server's own-side update, the predicting
  // client's trajectory matches authority → no pass-through, no reconciliation jitter.
  // obstacles: [{ id, x, y, vx, vy }] — usually the interpolated remote avatars.
  function resolveOwnCollision(s, obstacles) {
    if (s.grabbedBy) return;
    const minDist = C.BLOB_R * 2.1;
    const SLOP = 3;                                      // resting tolerance: don't correct tiny overlaps →
                                                        // kills the two-body feedback jitter when blobs touch
    for (const o of obstacles) {
      if (s.grabbing === o.id) continue;
      if (s.noCollideId === o.id && s.noCollideTicks > 0) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist || dist <= 0.5) continue;
      const nx = dx / dist, ny = dy / dist, overlap = minDist - dist;
      if (overlap > SLOP) { s.x -= nx * (overlap - SLOP) * 0.5; s.y -= ny * (overlap - SLOP) * 0.3; }
      const ovx = o.vx || 0, ovy = o.vy || 0;
      const vn = (ovx - s.vx) * nx + (ovy - s.vy) * ny;
      if (vn < -0.6) { const imp = -vn * 0.6; s.vx -= nx * imp; s.vy -= ny * imp * 0.5; } // ignore interpolation-jitter rel-vel
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
    s.lastSeq = a.seq;
  }

  return {
    C, STAGE_LAYOUTS, layoutIndex, platformsFor, floorY,
    createState, stepMovement, resolveGrabThrow, resolveCollisions, resolveOwnCollision, snapshot, applySnapshot
  };
});
