import './style.css';
import { GENE_KEYS, GENE_LABELS, type Genes, type GeneKey } from './genes';
import { drawChart, Renderer } from './render';
import { World, type Creature } from './world';

const WORLD_W = 1600;
const WORLD_H = 1000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('world');
const chart = $<HTMLCanvasElement>('chart');
const world = new World(WORLD_W, WORLD_H);
const renderer = new Renderer(canvas, world);

let paused = false;
let speed = 1;
let tool: 'inspect' | 'grass' | 'herb' | 'carn' = 'inspect';
let selected: Creature | null = null;

// ---------- размер холста ----------
function resize(): void {
  const wrap = canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const availW = wrap.clientWidth;
  const availH = wrap.clientHeight;
  const ratio = WORLD_W / WORLD_H;
  let w = availW;
  let h = w / ratio;
  if (h > availH) {
    h = availH;
    w = h * ratio;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}
window.addEventListener('resize', resize);
resize();

// ---------- управление ----------
const pauseBtn = $<HTMLButtonElement>('pause');
pauseBtn.onclick = () => {
  paused = !paused;
  pauseBtn.textContent = paused ? '▶ Пуск' : '⏸ Пауза';
};
$<HTMLButtonElement>('reset').onclick = () => {
  world.reset();
  selected = null;
};

function bindRange(id: string, apply: (v: number) => string): void {
  const input = $<HTMLInputElement>(id);
  const out = $<HTMLElement>(`${id}-val`);
  const update = () => (out.textContent = apply(Number(input.value)));
  input.addEventListener('input', update);
  update();
}
bindRange('speed', (v) => {
  speed = v;
  return `×${v}`;
});
bindRange('mutation', (v) => {
  world.settings.mutationRate = v / 100;
  return `${v}%`;
});
bindRange('growth', (v) => {
  world.settings.grassGrowth = v / 100;
  return `${v}%`;
});

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
  btn.onclick = () => {
    tool = btn.dataset.tool as typeof tool;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
    canvas.style.cursor = tool === 'inspect' ? 'pointer' : 'crosshair';
  };
});

// ---------- мышь ----------
function toWorld(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * WORLD_W, ((e.clientY - r.top) / r.height) * WORLD_H];
}

let painting = false;
canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = toWorld(e);
  if (tool === 'inspect') {
    selected = world.creatureAt(x, y);
  } else if (tool === 'grass') {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    world.paintGrass(x, y, 50);
  } else {
    selected = world.spawn(tool, x, y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (painting) world.paintGrass(...toWorld(e), 50);
});
canvas.addEventListener('pointerup', () => (painting = false));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    pauseBtn.click();
  }
});

// ---------- панель статистики ----------
const fmt = (k: GeneKey, v: number) => (k === 'generosity' ? `${Math.round(v * 100)}%` : v.toFixed(k === 'sense' ? 0 : 2));

function geneTable(g: Genes): string {
  return GENE_KEYS.map((k) => `<tr><td>${GENE_LABELS[k]}</td><td>${fmt(k, g[k])}</td></tr>`).join('');
}

function renderStats(): void {
  const parts: string[] = [];
  for (const sp of ['herb', 'carn'] as const) {
    const avg = world.averageGenes(sp);
    const title = sp === 'herb' ? '🌿 Травоядные' : '🦊 Хищники';
    parts.push(`<div class="species ${sp}"><h3>${title} <span>${avg?.count ?? 0}</span></h3>`);
    parts.push(
      avg
        ? `<table>${geneTable(avg)}<tr><td>Макс. поколение</td><td>${avg.maxGen}</td></tr></table>`
        : '<p class="muted">вымерли</p>',
    );
    parts.push('</div>');
  }
  $('stats').innerHTML = parts.join('');
  $('tick').textContent = `День ${Math.floor(world.tick / 100)}`;

  const insp = $('inspector');
  if (!selected) {
    insp.innerHTML = '<p class="muted">Кликните по существу, чтобы посмотреть его гены.</p>';
    return;
  }
  const c = selected;
  const states = { wander: 'бродит', graze: 'пасётся', flee: 'убегает!', hunt: 'охотится' };
  const maxE = world.maxEnergy(c.genes);
  insp.innerHTML = `
    <h3>${c.species === 'herb' ? '🌿' : '🦊'} Особь #${c.id} ${c.alive ? '' : '<span class="dead">✝ погибла</span>'}</h3>
    <div class="bar"><div style="width:${Math.max(0, (c.energy / maxE) * 100)}%"></div></div>
    <table>
      <tr><td>Состояние</td><td>${c.alive ? states[c.state] : '—'}</td></tr>
      <tr><td>Возраст</td><td>${c.age}</td></tr>
      <tr><td>Поколение</td><td>${c.generation}</td></tr>
      <tr><td>Потомков</td><td>${c.children}</td></tr>
      ${c.species === 'carn' ? `<tr><td>Добыча</td><td>${c.kills}</td></tr>` : ''}
      ${geneTable(c.genes)}
    </table>`;
}

// ---------- главный цикл ----------
let frame = 0;
function loop(): void {
  if (!paused) for (let i = 0; i < speed; i++) world.step();
  renderer.draw(selected);
  if (frame++ % 10 === 0) {
    renderStats();
    drawChart(chart, world);
  }
  requestAnimationFrame(loop);
}
loop();
