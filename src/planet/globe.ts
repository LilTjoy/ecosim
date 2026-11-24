import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp, mulberry32 } from '../lib/random';
import type { Derived, PlanetParams, Sample } from './model';

const TW = 512;
/** Широта, выше которой у разреженного мира лежат полярные шапки (~66°, как сезонные шапки Марса). */
const POLAR_CAP = 1.15;
const TH = 256;

/** 3D value noise — чтобы на сфере не было шва. */
class Noise3 {
  constructor(private seed: number) {}
  private h(x: number, y: number, z: number): number {
    let n = (x * 374761393 + y * 668265263 + z * 2147483647 + this.seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  value(x: number, y: number, z: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const s = (t: number) => t * t * (3 - 2 * t);
    const fx = s(x - xi);
    const fy = s(y - yi);
    const fz = s(z - zi);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(this.h(xi, yi, zi), this.h(xi + 1, yi, zi), fx), l(this.h(xi, yi + 1, zi), this.h(xi + 1, yi + 1, zi), fx), fy),
      l(l(this.h(xi, yi, zi + 1), this.h(xi + 1, yi, zi + 1), fx), l(this.h(xi, yi + 1, zi + 1), this.h(xi + 1, yi + 1, zi + 1), fx), fy),
      fz,
    );
  }
  fbm(x: number, y: number, z: number, oct: number): number {
    let a = 0.5;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += a * this.value(x * f, y * f, z * f);
      norm += a;
      a *= 0.5;
      f *= 2.1;
    }
    return sum / norm;
  }
}

const PLANET_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const PLANET_FS = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D lightsMap;
uniform vec3 lightDir;
uniform vec3 glowColor;
uniform float glowStrength;
uniform float cityAmt;
uniform vec3 starColor;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  vec4 day = texture2D(dayMap, vUv);
  vec3 n = normalize(vN);
  float ndl = dot(n, lightDir);
  float diff = clamp(ndl, 0.0, 1.0);
  vec3 col = day.rgb * (0.035 + diff * 1.08) * mix(vec3(1.0), starColor, 0.35);
  vec3 v = normalize(cameraPosition - vP);
  vec3 h = normalize(lightDir + v);
  float spec = pow(max(dot(n, h), 0.0), 70.0) * day.a * 0.7 * step(0.0, ndl);
  col += spec * starColor;
  float night = smoothstep(0.08, -0.25, ndl);
  col += texture2D(lightsMap, vUv).rgb * night * cityAmt;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += glowColor * rim * glowStrength * (diff * 0.9 + 0.08);
  gl_FragColor = vec4(col, 1.0);
}`;

const CLOUD_FS = /* glsl */ `
uniform sampler2D cloudMap;
uniform vec3 lightDir;
uniform float cover;
uniform vec3 cloudColor;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  float c = texture2D(cloudMap, vUv).r;
  float a = smoothstep(1.0 - cover - 0.06, 1.0 - cover + 0.22, c);
  float diff = clamp(dot(normalize(vN), lightDir), 0.0, 1.0);
  gl_FragColor = vec4(cloudColor * (0.03 + diff), a * 0.8);
}`;

const ATMO_VS = /* glsl */ `
varying vec3 vNv;
varying vec3 vNw;
void main() {
  vNv = normalize(normalMatrix * normal);
  vNw = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMO_FS = /* glsl */ `
uniform vec3 glowColor;
uniform float glowStrength;
uniform vec3 lightDir;
varying vec3 vNv;
varying vec3 vNw;
void main() {
  float i = pow(clamp(0.62 + dot(vNv, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 5.0);
  float lit = clamp(dot(vNw, lightDir) * 0.9 + 0.35, 0.0, 1.0);
  gl_FragColor = vec4(glowColor * i * glowStrength * lit * 1.6, 1.0);
}`;

function starColorFor(teff: number): THREE.Color {
  // грубо: красные карлики — оранжево-красные, F-звёзды — бело-голубые
  const t = clamp((teff - 2800) / (7000 - 2800), 0, 1);
  const c = new THREE.Color();
  c.setRGB(1, clamp(0.45 + t * 0.6, 0, 1), clamp(0.2 + t * 0.95, 0, 1));
  return c;
}

export interface GlobeOptions {
  /** full — вращение и зум; rotate — только вращение (колесо прокручивает страницу); none — без управления. */
  controls?: 'full' | 'rotate' | 'none';
  stars?: boolean;
  maxDpr?: number;
  /** Настоящий размер планеты (без ограничения 0,7…1,6). */
  trueScale?: boolean;
  camDist?: number;
  /** Высота камеры над экватором, радианы (по умолчанию ≈9°). */
  camElev?: number;
  moonDist?: number;
  /** В узком окне не обрезать планету по бокам. */
  fit?: boolean;
}

export class Globe {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private planet: THREE.Mesh;
  private clouds: THREE.Mesh;
  private atmo: THREE.Mesh;
  private moonPivot = new THREE.Object3D();
  private moon: THREE.Mesh;
  private star: THREE.Sprite;
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private lightDir = new THREE.Vector3(1, 0.25, 0.4).normalize();

  private day = new Uint8Array(TW * TH * 4);
  private lights = new Uint8Array(TW * TH * 4);
  private cloud = new Uint8Array(TW * TH * 4);
  private dayTex: THREE.DataTexture;
  private lightsTex: THREE.DataTexture;
  private cloudTex: THREE.DataTexture;

  private height = new Float32Array(TW * TH);
  private moist = new Float32Array(TW * TH);
  private shade = new Float32Array(TW * TH);
  private rnd = new Float32Array(TW * TH);
  private sorted = new Float32Array(TW * TH);
  private lat = new Float32Array(TH);

  private derived: Derived | null = null;
  private locked = false;
  private spin = 0.12;
  private cloudSpin = 0;
  private time = 0;
  private lastKey = '';
  private bakedSeed: number | null = null;
  private rock: [number, number, number] | null = null;
  private wet = true;
  private resizeObserver: ResizeObserver;

  constructor(
    private container: HTMLElement,
    private opts: GlobeOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(opts.maxDpr ?? 2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x05060a);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
    const elev = opts.camElev ?? Math.atan2(0.7, 4.4);
    this.camera.position.set(0, Math.sin(elev), Math.cos(elev)).multiplyScalar(opts.camDist ?? Math.hypot(0.7, 4.4));
    this.camera.lookAt(0, 0, 0);
    const mode = opts.controls ?? 'full';
    if (mode !== 'none') {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.enablePan = false;
      this.controls.minDistance = 1.7;
      this.controls.maxDistance = 14;
      // без зума колесо мыши прокручивает страницу, а не планету
      if (mode === 'rotate') this.controls.enableZoom = false;
    }

    const mk = (data: Uint8Array) => {
      const t = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, TW, TH, THREE.RGBAFormat);
      t.wrapS = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.dayTex = mk(this.day);
    this.lightsTex = mk(this.lights);
    this.cloudTex = mk(this.cloud);

    const uniforms = {
      lightDir: { value: this.lightDir },
      glowColor: { value: new THREE.Color(0.35, 0.6, 1) },
      glowStrength: { value: 1 },
      starColor: { value: new THREE.Color(1, 1, 1) },
    };
    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 64),
      new THREE.ShaderMaterial({
        vertexShader: PLANET_VS,
        fragmentShader: PLANET_FS,
        uniforms: { ...uniforms, dayMap: { value: this.dayTex }, lightsMap: { value: this.lightsTex }, cityAmt: { value: 0 } },
      }),
    );
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.012, 96, 48),
      new THREE.ShaderMaterial({
        vertexShader: PLANET_VS,
        fragmentShader: CLOUD_FS,
        transparent: true,
        depthWrite: false,
        uniforms: { lightDir: uniforms.lightDir, cloudMap: { value: this.cloudTex }, cover: { value: 0.5 }, cloudColor: { value: new THREE.Color(1, 1, 1) } },
      }),
    );
    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.07, 96, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMO_VS,
        fragmentShader: ATMO_FS,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        uniforms: { glowColor: uniforms.glowColor, glowStrength: uniforms.glowStrength, lightDir: uniforms.lightDir },
      }),
    );
    this.scene.add(this.planet, this.clouds, this.atmo);

    // спутник
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(0.27, 48, 24), new THREE.MeshStandardMaterial({ map: this.moonTexture(), roughness: 1 }));
    this.moon.position.set(opts.moonDist ?? 3.4, 0, 0);
    this.moonPivot.rotation.z = 0.09;
    this.moonPivot.add(this.moon);
    this.scene.add(this.moonPivot);

    // звезда
    this.star = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.scene.add(this.star);
    this.sun.position.copy(this.lightDir).multiplyScalar(10);
    this.scene.add(this.sun, new THREE.AmbientLight(0xffffff, 0.04));
    if (opts.stars !== false) this.scene.add(this.starfield());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private moonTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d')!;
    const n = new Noise3(77);
    const img = g.createImageData(256, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 256; x++) {
        const lon = (x / 256) * Math.PI * 2;
        const lat = (y / 128) * Math.PI;
        const v = n.fbm(Math.sin(lat) * Math.cos(lon) * 4, Math.cos(lat) * 4, Math.sin(lat) * Math.sin(lon) * 4, 5);
        const k = 90 + v * 120;
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  }

  private glowTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.12, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  private starfield(): THREE.Points {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const r = mulberry32(9);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * s * 300, u * 300, Math.sin(a) * s * 300], i * 3);
      const b = 0.4 + r() * 0.6;
      const tint = r();
      col.set([b * (tint > 0.8 ? 1 : 0.85), b * 0.9, b * (tint < 0.2 ? 0.7 : 1)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    // узкое окно: расширяем вертикальный угол обзора, чтобы по горизонтали влезало столько же
    if (this.opts.fit) this.camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) / (w / h)) * 180) / Math.PI : 38;
    this.camera.updateProjectionMatrix();
  }

  /** Новая планета: рельеф, спутник, звезда. Рельеф пересчитывается, только если сменился seed. */
  setPlanet(p: PlanetParams, d: Derived, look?: { rock?: [number, number, number] }): void {
    this.derived = d;
    this.lastKey = '';
    if (p.seed !== this.bakedSeed) this.bake(p.seed);
    this.rock = look?.rock ?? null;
    this.wet = p.water > 0.01;

    this.planet.scale.setScalar(this.opts.trueScale ? d.radius : clamp(d.radius, 0.7, 1.6));
    this.clouds.scale.copy(this.planet.scale);
    this.atmo.scale.copy(this.planet.scale);
    this.moon.visible = p.moon > 0;
    this.moon.scale.setScalar(Math.cbrt(Math.max(p.moon, 0.05)));
    this.locked = d.tidalLock;
    // медленное вращение (Венера) — планета почти стоит, а облака обгоняют её (суперротация)
    const rot = p.rotation ?? 1;
    this.spin = 0.12 / clamp(rot, 1, 60);
    this.cloudSpin = rot > 20 ? 0.25 : 0;

    const sc = starColorFor(d.teff);
    (this.planet.material as THREE.ShaderMaterial).uniforms.starColor.value = sc;
    this.star.material.color = sc;
    const starR = Math.pow(p.starMass, 0.8);
    const s = clamp((6 * starR) / p.orbit, 1.5, 24);
    this.star.scale.setScalar(s);
    this.star.position.copy(this.lightDir).multiplyScalar(60);
    this.sun.color = sc;
  }

  /** Тяжёлая часть: рельеф, влажность и облака из шума (~131 тыс. пикселей). */
  private bake(seed: number): void {
    this.bakedSeed = seed;
    const n = new Noise3(seed);
    const nm = new Noise3(seed + 1);
    const nc = new Noise3(seed + 2);
    const r = mulberry32(seed + 3);
    for (let y = 0; y < TH; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / TH) * Math.PI;
      this.lat[y] = lat;
      for (let x = 0; x < TW; x++) {
        const lon = ((x + 0.5) / TW) * Math.PI * 2;
        const px = Math.cos(lat) * Math.cos(lon);
        const py = Math.sin(lat);
        const pz = Math.cos(lat) * Math.sin(lon);
        const i = y * TW + x;
        // континенты: крупный шум + горные хребты
        const base = n.fbm(px * 1.6 + 10, py * 1.6, pz * 1.6, 6);
        const ridge = 1 - Math.abs(n.fbm(px * 4 + 3, py * 4, pz * 4, 4) * 2 - 1);
        this.height[i] = base * 0.85 + ridge * ridge * 0.15;
        this.moist[i] = nm.fbm(px * 2.5, py * 2.5, pz * 2.5, 4);
        // облака: вытянуты вдоль широт
        const cl = nc.fbm(px * 3, py * 7, pz * 3, 5);
        const ci = i * 4;
        this.cloud[ci] = this.cloud[ci + 1] = this.cloud[ci + 2] = clamp(cl * 1.25 - 0.1, 0, 1) * 255;
        this.cloud[ci + 3] = 255;
        this.rnd[i] = r();
      }
    }
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const i = y * TW + x;
        const dx = this.height[y * TW + ((x + 1) % TW)] - this.height[y * TW + ((x + TW - 1) % TW)];
        const dy = this.height[Math.min(TH - 1, y + 1) * TW + x] - this.height[Math.max(0, y - 1) * TW + x];
        this.shade[i] = clamp(1 + (dx - dy) * 9, 0.72, 1.3);
      }
    }
    this.sorted.set(this.height);
    this.sorted.sort();
    this.cloudTex.needsUpdate = true;
  }

  /** Перекрасить планету под состояние на данный момент истории. */
  setState(s: Sample, tech: boolean): void {
    const d = this.derived;
    if (!d) return;
    const P = s.pressure + s.co2;
    // почти без воздуха: нет снегопадов и открытой воды
    const thin = P < 0.03;
    // океан горячее кипения — планета укутана паром
    const steam = s.ocean > 0.01 && s.T > 373;
    const key = [Math.round(s.T / 2), Math.round(s.ocean * 40), Math.round(s.ice * 20), s.stage, Math.round(Math.log10(s.co2 + 1e-7) * 3), Math.round(s.o2 * 40), tech, thin, steam, Math.round(Math.log10(P + 1e-4) * 4)].join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const N = TW * TH;
    const land = s.ocean <= 0.005 ? 1 : clamp(1 - (1 - d.land) * Math.pow(s.ocean, 0.6), 0, 1);
    const sea = land >= 1 ? -1 : this.sorted[Math.floor(clamp(1 - land, 0, 0.999) * N)];
    const top = this.sorted[N - 1];
    // сухой холодный мир — не снежок: льду просто неоткуда взяться
    const snowball = s.ice > 0.9 && !thin && s.ocean > 0.01;
    const life = s.stage;
    const venus = s.ocean <= 0.005 && s.T > 340;
    const T = s.T;

    for (let y = 0; y < TH; y++) {
      const lat = this.lat[y];
      const latT = T + 12 - 47 * (1 - Math.cos(lat));
      for (let x = 0; x < TW; x++) {
        const i = y * TW + x;
        const h = this.height[i];
        const o = i * 4;
        let r: number;
        let g: number;
        let b: number;
        let water = 0;
        let city = 0;
        if (h < sea && thin) {
          // высохшие котловины бывших морей: тёмная низменность, лёд — только в полярных шапках
          const base = this.rockColor(0, thin, venus, T);
          const polar = Math.abs(lat) > POLAR_CAP;
          const sh = this.shade[i];
          r = polar ? 232 : base[0] * 0.8 * sh;
          g = polar ? 238 : base[1] * 0.8 * sh;
          b = polar ? 244 : base[2] * 0.8 * sh;
        } else if (h < sea) {
          const depth = clamp((sea - h) * 6, 0, 1);
          if (latT < 271 || snowball) {
            r = 220;
            g = 232;
            b = 242;
          } else {
            // цвет океана зависит от эпохи: мёртвый, бактериальный (зеленоватый), современный
            const shallow = life >= 1 && s.o2 < 0.002 ? [40, 120, 110] : T > 320 ? [80, 100, 100] : [36, 110, 160];
            const deep = life >= 1 && s.o2 < 0.002 ? [14, 52, 60] : T > 320 ? [40, 55, 60] : [8, 32, 80];
            r = shallow[0] + (deep[0] - shallow[0]) * depth;
            g = shallow[1] + (deep[1] - shallow[1]) * depth;
            b = shallow[2] + (deep[2] - shallow[2]) * depth;
            water = 255;
          }
        } else {
          const e = sea < 0 ? (h - this.sorted[0]) / (top - this.sorted[0]) : (h - sea) / Math.max(1e-3, top - sea);
          const lt = latT - e * 40;
          const m = this.moist[i];
          // голые породы
          [r, g, b] = this.rockColor(e, thin, venus, T);
          if (life >= 5 && lt > 262 && lt < 318) {
            // растительность: лес / степь / пустыня / тундра
            const warm = clamp((lt - 262) / 40, 0, 1);
            let vr: number, vg: number, vb: number;
            if (m < 0.42 && lt > 290) {
              vr = 196; vg = 172; vb = 118; // пустыня
            } else if (lt < 272) {
              vr = 108; vg = 118; vb = 96; // тундра
            } else if (m > 0.52) {
              vr = 34; vg = 86 + warm * 10; vb = 38; // лес
            } else {
              vr = 104; vg = 138; vb = 60; // степь
            }
            const k = clamp(1 - e * 1.4, 0, 1);
            r = r + (vr - r) * k;
            g = g + (vg - g) * k;
            b = b + (vb - b) * k;
          } else if (life >= 2 && life < 5 && h - sea < 0.01 && lt > 270) {
            // бактериальные маты на побережье
            r = r * 0.8 + 20;
            g = g * 0.85 + 30;
            b = b * 0.8;
          }
          if (thin ? Math.abs(lat) > POLAR_CAP && this.wet : snowball || lt < 266 || (e > 0.7 && lt < 285)) {
            r = 232;
            g = 238;
            b = 244;
          }
          const sh = this.shade[i];
          r *= sh;
          g *= sh;
          b *= sh;
          if (tech && lt > 265 && lt < 310 && this.rnd[i] > 0.86 && (h - sea < 0.05 || this.rnd[i] > 0.97)) city = 1;
        }
        this.day[o] = clamp(r, 0, 255);
        this.day[o + 1] = clamp(g, 0, 255);
        this.day[o + 2] = clamp(b, 0, 255);
        this.day[o + 3] = water;
        this.lights[o] = city * 255;
        this.lights[o + 1] = city * 190;
        this.lights[o + 2] = city * 110;
        this.lights[o + 3] = 255;
      }
    }
    this.dayTex.needsUpdate = true;
    this.lightsTex.needsUpdate = true;

    const pm = (this.planet.material as THREE.ShaderMaterial).uniforms;
    pm.cityAmt.value = tech ? 1.4 : 0;
    // атмосфера: голубая от кислорода, оранжевая от метановой дымки, жёлтая у «Венеры»
    const glow = pm.glowColor.value as THREE.Color;
    if (steam) glow.setRGB(0.9, 0.9, 0.85);
    else if (venus || s.co2 > 1) glow.setRGB(1, 0.82, 0.5);
    else if (life >= 1 && s.o2 < 0.002) glow.setRGB(1, 0.62, 0.32);
    else if (s.o2 > 0.02) glow.setRGB(0.32, 0.58, 1);
    else glow.setRGB(0.55, 0.68, 0.85);
    pm.glowStrength.value = clamp(Math.sqrt(s.pressure + s.co2) * 0.9, 0, 1.6);
    const cm = (this.clouds.material as THREE.ShaderMaterial).uniforms;
    let cover = thin ? 0 : clamp(0.2 + s.ocean * 0.12 + (T - 288) / 120, 0.05, 0.7);
    if (venus && P > 3) cover = 1;
    if (steam) cover = 1;
    cm.cover.value = cover;
    const cc = cm.cloudColor.value as THREE.Color;
    if (steam) cc.setRGB(0.92, 0.92, 0.9);
    else cc.setRGB(1, venus ? 0.88 : 1, venus ? 0.62 : 1);
  }

  /** Цвет голых пород: e — высота 0…1. */
  private rockColor(e: number, thin: boolean, venus: boolean, T: number): [number, number, number] {
    // ржавчина: железо окислилось, пока была вода (Марс); сухие безвоздушные миры — серые, как Луна
    const rock = this.rock ?? (thin && this.wet && !venus ? ([176, 96, 60] as [number, number, number]) : null);
    if (rock) return [rock[0] * (0.85 + e * 0.3), rock[1] * (0.85 + e * 0.3), rock[2] * (0.85 + e * 0.3)];
    if (venus) return [170 + e * 30, 135 + e * 20, 85];
    if (T > 330) return [150, 95, 65];
    return [118 + e * 30, 104 + e * 26, 90 + e * 24];
  }

  frame(dt: number): void {
    this.time += dt;
    if (!this.locked) this.planet.rotation.y += dt * this.spin;
    this.clouds.rotation.y = this.planet.rotation.y + performance.now() / 40000 + this.time * this.cloudSpin;
    this.atmo.rotation.y = this.planet.rotation.y;
    this.moonPivot.rotation.y += dt * 0.08;
    this.moon.rotation.y += dt * 0.08;
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Освободить WebGL-контекст и всю память видеокарты. */
  dispose(): void {
    this.controls?.dispose();
    this.resizeObserver.disconnect();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        const u = (mat as THREE.ShaderMaterial).uniforms;
        if (u) for (const k in u) if (u[k].value instanceof THREE.Texture) u[k].value.dispose();
        mat.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
