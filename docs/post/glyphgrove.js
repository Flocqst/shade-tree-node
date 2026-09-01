/* Glyph grove band: ascii trees behind the getting-started section.
   The canvas measures [data-clearing] elements and parts the glyphs
   around them with a feathered edge, so content sits in clearings. */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var RAMP = '·:;+*xeoa%&#@';
  var GREEN_TIERS = 16;
  var GOLD_TIERS = 8;
  var FEATHER = 64; // px of glyph fade around each clearing

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function hash(ix, iy, seed) {
    var h = (ix * 374761393 + iy * 668265263 + seed * 974634) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function vnoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    var a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
    var c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* moss -> leaf -> lichen: the site's own greens, not phosphor mint */
  function greenColor(t) {
    var r, g, b;
    if (t < 0.7) {
      var u = t / 0.7;
      r = lerp(22, 116, u); g = lerp(40, 150, u); b = lerp(28, 110, u);
    } else {
      var v = (t - 0.7) / 0.3;
      r = lerp(116, 210, v); g = lerp(150, 224, v); b = lerp(110, 196, v);
    }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  /* rare sparks in the site's pulse gold */
  function goldColor(t) {
    var r, g, b;
    if (t < 0.7) {
      var u = t / 0.7;
      r = lerp(90, 226, u); g = lerp(70, 190, u); b = lerp(30, 103, u);
    } else {
      var v = (t - 0.7) / 0.3;
      r = lerp(226, 255, v); g = lerp(190, 228, v); b = lerp(103, 168, v);
    }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  function GlyphGrove(section) {
    this.section = section;
    this.canvas = section.querySelector('.glyph-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    if (!this.ctx) return;
    this.seed = 11;
    this.visible = true;
    this.running = false;
    this.last = 0;
    this.t0 = performance.now();
    this.loop = this.loop.bind(this);
    this.build();
    this.observe();
    if (reduced.matches) this.drawFrame(0, true);
    else this.start();

    var self = this;
    reduced.addEventListener && reduced.addEventListener('change', function () {
      if (reduced.matches) { self.stop(); self.drawFrame(0, true); }
      else { self.start(); }
    });
    var resizeT = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        self.build();
        if (reduced.matches) self.drawFrame(0, true);
      }, 180);
    });
    /* clearing rects depend on final layout: rebuild once everything loads */
    window.addEventListener('load', function () {
      self.build();
      if (reduced.matches) self.drawFrame(0, true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.stop();
      else if (!reduced.matches && self.visible) self.start();
    });
  }

  GlyphGrove.prototype.observe = function () {
    var self = this;
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) {
      self.visible = entries[0].isIntersecting;
      if (!self.visible) self.stop();
      else if (!reduced.matches) self.start();
    }, { threshold: 0.02 }).observe(this.canvas);
  };

  /* 0 inside a clearing, ramping to 1 beyond the feather */
  GlyphGrove.prototype.clearingFactor = function (x, y) {
    var f = 1;
    for (var i = 0; i < this.clearings.length; i++) {
      var r = this.clearings[i];
      var dx = Math.max(r.left - x, 0, x - r.right);
      var dy = Math.max(r.top - y, 0, y - r.bottom);
      var d = Math.sqrt(dx * dx + dy * dy);
      var t = Math.min(1, d / FEATHER);
      t = t * t * (3 - 2 * t);
      if (t < f) f = t;
    }
    return f;
  };

  GlyphGrove.prototype.build = function () {
    var canvas = this.canvas;
    var srect = this.section.getBoundingClientRect();
    var w = Math.max(1, srect.width), h = Math.max(1, srect.height);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;

    /* clearing rects in section-local coordinates */
    this.clearings = [];
    var nodes = this.section.querySelectorAll('[data-clearing]');
    for (var ci = 0; ci < nodes.length; ci++) {
      var r = nodes[ci].getBoundingClientRect();
      this.clearings.push({
        left: r.left - srect.left, right: r.right - srect.left,
        top: r.top - srect.top, bottom: r.bottom - srect.top
      });
    }

    var cell = w < 600 ? 13 : 16;
    this.cell = cell;
    var cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    var seed = this.seed;
    var cells = [];

    /* crowns across the top band of the section */
    var trees = [];
    var n = Math.max(3, Math.min(7, Math.round(w / 265)));
    for (var i = 0; i < n; i++) {
      var jx = hash(i, 3, seed);
      trees.push({
        x: ((i + 0.5) / n + (jx - 0.5) * 0.5 / n) * w,
        y: 155 + 75 * hash(i, 5, seed),
        rx: (w / n) * (0.78 + 0.5 * hash(i, 7, seed)),
        ry: 96 + 60 * hash(i, 9, seed)
      });
    }

    for (var rr = 0; rr < rows; rr++) {
      for (var cc = 0; cc < cols; cc++) {
        var px = (cc + 0.5) * cell, py = (rr + 0.5) * cell;
        var noise = 0.62 * vnoise(px / 64, py / 46, seed) +
                    0.38 * vnoise(px / 21, py / 16, seed + 7);
        var crown = 0;
        for (var k = 0; k < trees.length; k++) {
          var tr = trees[k];
          var dx = (px - tr.x) / tr.rx, dy = (py - tr.y) / tr.ry;
          var f = 1 - Math.sqrt(dx * dx + dy * dy);
          if (f > crown) crown = f;
        }
        if (crown < 0) crown = 0;
        var d = crown * (0.32 + 0.95 * noise);
        if (d <= 0.2) continue;
        var open = this.clearingFactor(px, py);
        if (open < 0.06) continue;
        var dd = Math.min(1, (d - 0.2) / 0.62);
        var topFade = Math.min(1, py / 60);
        cells.push({
          x: cc * cell, y: rr * cell,
          ch: Math.min(RAMP.length - 1, Math.floor(dd * RAMP.length)),
          base: (0.16 + 0.62 * dd) * open * topFade,
          phase: hash(cc, rr, seed + 13),
          rate: 0.22 + 0.5 * hash(cc, rr, seed + 17),
          gold: hash(cc, rr, seed + 31) < 0.04 && dd > 0.3,
          nf: 2 + 14 * hash(cc, rr, seed + 23),
          famp: 0, fstart: -10
        });
      }
    }

    /* trunks descend the full band, parting at clearings */
    var groundY = h - cell * 1.4;
    for (var ti = 0; ti < trees.length; ti++) {
      var t = trees[ti];
      var col = Math.round(t.x / cell);
      var fromRow = Math.round((t.y + t.ry * 0.45) / cell);
      var toRow = Math.floor(groundY / cell);
      for (var tr2 = fromRow; tr2 <= toRow; tr2++) {
        var lean = vnoise(tr2 / 3, ti * 9, seed + 41) - 0.5;
        var c2 = col + Math.round(lean * 1.0);
        var tx = (c2 + 0.5) * cell, ty = (tr2 + 0.5) * cell;
        var open2 = this.clearingFactor(tx, ty);
        if (open2 < 0.06) continue;
        cells.push({
          x: c2 * cell, y: tr2 * cell,
          ch: -1,
          base: (0.2 + 0.1 * hash(c2, tr2, seed + 43)) * open2,
          phase: hash(c2, tr2, seed + 47),
          rate: 0.12,
          gold: false,
          nf: 1e9, famp: 0, fstart: -10
        });
      }
    }

    /* sparse undergrowth line closing the band */
    var gRow = Math.floor((h - cell * 1.6) / cell);
    for (var gr = gRow; gr <= gRow + 1; gr++) {
      for (var gc = 0; gc < cols; gc++) {
        var gh = hash(gc, gr, seed + 61);
        var sparse = gr === gRow ? 0.34 : 0.62;
        if (gh < sparse) continue;
        var gx = (gc + 0.5) * cell, gy = (gr + 0.5) * cell;
        var gOpen = this.clearingFactor(gx, gy);
        if (gOpen < 0.06) continue;
        cells.push({
          x: gc * cell, y: gr * cell,
          ch: Math.floor(hash(gc, gr, seed + 67) * 4),
          base: (0.08 + 0.14 * gh) * gOpen,
          phase: hash(gc, gr, seed + 71),
          rate: 0.15 + 0.3 * gh,
          gold: hash(gc, gr, seed + 73) < 0.03,
          nf: 1e9, famp: 0, fstart: -10
        });
      }
    }

    this.cellsArr = cells;
    this.buildAtlas();
  };

  GlyphGrove.prototype.buildAtlas = function () {
    var s = Math.ceil(this.cell * this.dpr);
    var chars = RAMP.length + 1;
    var tiers = GREEN_TIERS + GOLD_TIERS;
    var atlas = document.createElement('canvas');
    atlas.width = s * chars;
    atlas.height = s * tiers;
    var g = atlas.getContext('2d');
    g.font = (s * 0.86) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (var t = 0; t < tiers; t++) {
      var isGold = t >= GREEN_TIERS;
      var tt = isGold ? (t - GREEN_TIERS) / (GOLD_TIERS - 1) : t / (GREEN_TIERS - 1);
      var col = isGold ? goldColor(tt) : greenColor(tt);
      g.fillStyle = col;
      if (tt > 0.6) {
        g.shadowColor = col;
        g.shadowBlur = (tt - 0.6) * 10 * this.dpr;
      } else {
        g.shadowBlur = 0;
      }
      for (var ci = 0; ci < chars; ci++) {
        g.fillText(ci < RAMP.length ? RAMP[ci] : '|', ci * s + s / 2, t * s + s / 2 + s * 0.03);
      }
    }
    this.atlas = atlas;
    this.as = s;
  };

  GlyphGrove.prototype.drawFrame = function (t, still) {
    var ctx = this.ctx, dpr = this.dpr, s = this.as;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    var cells = this.cellsArr;
    for (var i = 0; i < cells.length; i++) {
      var cl = cells[i];
      var b = cl.base;
      if (!still) {
        b *= 0.68 + 0.32 * Math.sin(t * cl.rate * TAU * 0.16 + cl.phase * TAU);
        if (t >= cl.nf) {
          cl.fstart = t;
          cl.famp = (Math.sin(cl.phase * 9871 + t) > 0.3 ? 0.7 : -0.45) * (0.4 + 0.6 * cl.phase);
          cl.nf = t + 3 + 16 * hash(i, (t * 7) | 0, 91);
        }
        var ft = t - cl.fstart;
        if (ft >= 0 && ft < 0.7) {
          var env = ft < 0.12 ? ft / 0.12 : 1 - (ft - 0.12) / 0.58;
          b += cl.famp * env * cl.base * 1.6;
        }
      } else {
        b *= 0.8;
      }
      if (b <= 0.02) continue;
      if (b > 1) b = 1;
      var chIdx = cl.ch < 0 ? RAMP.length : cl.ch;
      var tier = cl.gold
        ? GREEN_TIERS + Math.min(GOLD_TIERS - 1, Math.round((0.35 + 0.65 * b) * (GOLD_TIERS - 1)))
        : Math.min(GREEN_TIERS - 1, Math.round(b * (GREEN_TIERS - 1)));
      ctx.drawImage(this.atlas, chIdx * s, tier * s, s, s,
        Math.round(cl.x * dpr), Math.round(cl.y * dpr), s, s);
    }
  };

  GlyphGrove.prototype.loop = function (now) {
    if (!this.running) return;
    if (now - this.last >= 33) {
      this.last = now;
      this.drawFrame((now - this.t0) / 1000, false);
    }
    requestAnimationFrame(this.loop);
  };

  GlyphGrove.prototype.start = function () {
    if (this.running || !this.ctx) return;
    this.running = true;
    requestAnimationFrame(this.loop);
  };

  GlyphGrove.prototype.stop = function () { this.running = false; };

  function init() {
    var sections = document.querySelectorAll('.glyph-grove');
    for (var i = 0; i < sections.length; i++) new GlyphGrove(sections[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
