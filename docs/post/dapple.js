/* global document, IntersectionObserver, requestAnimationFrame, window */

/* Dappled canopy light behind the how-it-works section: two drifting
   noise fields multiplied into sun-through-leaves patches, leaf-green
   warming to pulse gold, over the section's own clearing ground.
   Static frame under prefers-reduced-motion; flat bg if WebGL is out. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

  var FRAG = [
    'precision mediump float;',
    'uniform vec2 R;',
    'uniform float T;',
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float n(vec2 p){',
    '  vec2 i=floor(p),f=fract(p);',
    '  vec2 u=f*f*(3.-2.*f);',
    '  return mix(mix(h(i),h(i+vec2(1.,0.)),u.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),u.x),u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v=0.,a=.5;',
    '  for(int i=0;i<4;i++){v+=a*n(p);p=p*2.03+vec2(17.,9.);a*=.5;}',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/R.y;',
    '  float t=T*.018;',
    /* two canopy layers sliding past each other; their product is the gap light */
    '  float n1=fbm(uv*3.2+vec2(t*.80,-t*.35));',
    '  float n2=fbm(uv*5.0+vec2(-t*.55,t*.42)+7.31);',
    '  float gap=n1*n2*2.3;',
    '  float dap=smoothstep(.56,.78,gap);',
    '  float halo=smoothstep(.40,.66,gap);',
    '  float core=smoothstep(.72,.90,gap);',
    /* slow warmth drift decides which patches lean gold */
    '  float warm=fbm(uv*1.3+vec2(t*.20,3.7));',
    '  vec3 ground=vec3(.051,.122,.086);',
    '  vec3 leaf=vec3(.284,.408,.267);',
    '  vec3 gold=vec3(.886,.745,.404);',
    '  vec3 light=mix(leaf,gold,smoothstep(.45,.75,warm));',
    '  vec3 col=ground+light*(halo*.12+dap*.26)+gold*core*.18;',
    /* faint sky at the top edge, as if the canopy opens above */
    '  col+=light*smoothstep(.55,1.,gl_FragCoord.y/R.y)*.05;',
    '  gl_FragColor=vec4(col,1.);',
    '}'
  ].join('\n');

  function Dapple(section) {
    this.section = section;
    this.canvas = section.querySelector('.shade-canvas');
    if (!this.canvas) return;
    var gl = this.canvas.getContext('webgl', { antialias: false, depth: false, stencil: false })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) return;
    this.gl = gl;

    var prog = gl.createProgram();
    var ok = [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]].every(function (s) {
      var sh = gl.createShader(s[0]);
      gl.shaderSource(sh, s[1]);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return false;
      gl.attachShader(prog, sh);
      return true;
    });
    if (!ok) return;
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.uRes = gl.getUniformLocation(prog, 'R');
    this.uT = gl.getUniformLocation(prog, 'T');

    this.visible = true;
    this.running = false;
    this.last = 0;
    this.t0 = performance.now();
    this.loop = this.loop.bind(this);
    this.resize();

    /* paint before any visibility gating: never composite an empty canvas */
    this.drawFrame(reduced.matches ? 120 : 0);
    if (!reduced.matches) this.start();

    var self = this;
    reduced.addEventListener && reduced.addEventListener('change', function () {
      if (reduced.matches) { self.stop(); self.drawFrame(120); }
      else self.start();
    });
    var resizeT = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        self.resize();
        self.drawFrame(reduced.matches ? 120 : (performance.now() - self.t0) / 1000);
      }, 180);
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        self.visible = entries[0].isIntersecting;
        if (!self.visible) self.stop();
        else if (!reduced.matches) self.start();
      }, { threshold: 0.02 }).observe(this.canvas);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.stop();
      else if (!reduced.matches && self.visible) self.start();
    });
  }

  Dapple.prototype.resize = function () {
    var r = this.section.getBoundingClientRect();
    var dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  Dapple.prototype.drawFrame = function (t) {
    var gl = this.gl;
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uT, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  Dapple.prototype.loop = function (now) {
    if (!this.running) return;
    if (now - this.last >= 33) {
      this.last = now;
      /* height changes as lazy images land: keep the field in step */
      var r = this.section.getBoundingClientRect();
      var dpr = Math.min(1.5, window.devicePixelRatio || 1);
      if (Math.abs(this.canvas.height - r.height * dpr) > 2) this.resize();
      this.drawFrame((now - this.t0) / 1000);
    }
    requestAnimationFrame(this.loop);
  };

  Dapple.prototype.start = function () {
    if (this.running || !this.gl) return;
    this.running = true;
    requestAnimationFrame(this.loop);
  };

  Dapple.prototype.stop = function () { this.running = false; };

  function init() {
    var sections = document.querySelectorAll('.how-panel');
    for (var i = 0; i < sections.length; i++) new Dapple(sections[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
