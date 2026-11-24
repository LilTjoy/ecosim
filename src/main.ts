import './style.css';
import { GENE_KEYS, GENE_LABELS, SPECIES, SPECIES_INFO, type GeneKey, type Genes, type Species } from './genes';
import { drawBrain, drawGeneHistory, drawPopulation, Renderer } from './render';
import { DAY, World, type BrainMode, type Creature } from './world';

const WORLD_W = 1600;
const WORLD_H = 1000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('world');
const world = new World(WORLD_W, WORLD_H);
const renderer = new Renderer(canvas, world);

type Tool = 'inspect' | 'grass' | 'meteor' | Species;
let paused = false;
let speed = 1;
let tool: Tool = 'inspect';
let selected: Creature | null = null;
let family = new Set<Creature>();
let gene: GeneKey = 'speed';

// ---------- размер холста ----------
function resize(): void {
  const wrap = canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const availW = wrap.clientWidth - 32;
  const availH = wrap.clientHeight - 32;
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
const modeSelect = $<HTMLSelectElement>('mode');
$<HTMLButtonElement>('reset').onclick = () => {
  world.reset(modeSelect.value as BrainMode);
  selected = null;
  family = new Set();
};
modeSelect.onchange = () => $<HTMLButtonElement>('reset').click();
$<HTMLButtonElement>('drought-btn').onclick = () => world.startDrought();
$<HTMLButtonElement>('epidemic-btn').onclick = () => world.epidemic();
$<HTMLInputElement>('seasons').onchange = (e) => (world.settings.seasons = (e.target as HTMLInputElement).checked);

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
    tool = btn.dataset.tool as Tool;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
    canvas.style.cursor = tool === 'inspect' ? 'pointer' : 'crosshair';
  };
});

const geneSelect = $<HTMLSelectElement>('gene-select');
geneSelect.innerHTML = GENE_KEYS.map((k) => `<option value="${k}">${GENE_LABELS[k]}</option>`).join('');
geneSelect.onchange = () => (gene = geneSelect.value as GeneKey);

$('legend').innerHTML =
  SPECIES.map((sp) => `<span style="color:${SPECIES_INFO[sp].color}">● ${SPECIES_INFO[sp].name.toLowerCase()}</span>`).join('') +
  '<span class="grass">■ трава</span>';

// ---------- мышь ----------
function toWorld(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * WORLD_W, ((e.clientY - r.top) / r.height) * WORLD_H];
}

function select(c: Creature | null): void {
  selected = c;
  family = c ? world.descendants(c.id) : new Set();
  renderPanel();
}

let painting = false;
canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = toWorld(e);
  if (tool === 'inspect') {
    select(world.creatureAt(x, y));
  } else if (tool === 'grass') {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    world.paintGrass(x, y, 50);
  } else if (tool === 'meteor') {
    world.meteor(x, y);
    renderer.explosion(x, y);
  } else if (!world.isWater(x, y)) {
    select(world.spawn(tool, x, y));
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
  if (e.code === 'Escape') select(null);
});

// ---------- панель ----------
const fmt = (k: GeneKey, v: number) => (k === 'generosity' ? `${Math.round(v * 100)}%` : v.toFixed(k === 'sense' ? 0 : 2));

function geneRows(g: Record<GeneKey, number>, parent?: Genes): string {
  return GENE_KEYS.map((k) => {
    let diff = '';
    if (parent) {
      const d = (g[k] - parent[k]) / parent[k];
      if (Math.abs(d) > 0.005) diff = `<small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d * 100).toFixed(0)}%</small>`;
    }
    return `<tr><td>${GENE_LABELS[k]}</td><td>${diff} ${fmt(k, g[k])}</td></tr>`;
  }).join('');
}

function renderPanel(): void {
  // средние гены
  $('stats').innerHTML = SPECIES.map((sp) => {
    const avg = world.averageGenes(sp);
    const info = SPECIES_INFO[sp];
    return `<div class="species"><h3>${info.icon} ${info.name} <span style="color:${info.color}">${avg?.count ?? 0}</span></h3>${
      avg ? `<table>${geneRows(avg)}<tr><td>Макс. поколение</td><td>${avg.maxGen}</td></tr></table>` : '<p class="muted">вымерли — ждём мигрантов</p>'
    }</div>`;
  }).join('');

  // HUD
  const season = world.season;
  $('season').textContent = `${season.icon} ${season.name}, год ${world.year}`;
  $('tick').textContent = `день ${Math.floor(world.tick / DAY)}`;
  $('drought').hidden = world.drought === 0;

  // летопись
  $('events').innerHTML = world.events
    .slice()
    .reverse()
    .map((e) => `<li class="${e.kind}"><span>д.${Math.floor(e.tick / DAY)}</span> ${e.text}</li>`)
    .join('');

  renderInspector();
}

function renderInspector(): void {
  const insp = $('inspector');
  const brainCanvas = $<HTMLCanvasElement>('brain');
  const lineageEl = $('lineage');
  if (!selected) {
    insp.innerHTML = '<p class="muted">Кликните по существу, чтобы увидеть его гены, мозг и родословную.</p>';
    brainCanvas.hidden = true;
    lineageEl.innerHTML = '';
    return;
  }
  const c = selected;
  family = world.descendants(c.id);
  const states = { wander: 'бродит', graze: 'пасётся', flee: 'убегает!', hunt: 'охотится' };
  const maxE = world.maxEnergy(c.genes);
  const parent = c.parentId !== null ? world.ancestors.get(c.parentId) : undefined;
  insp.innerHTML = `
    <h3>${SPECIES_INFO[c.species].icon} Особь #${c.id} ${c.alive ? '' : '<span class="dead">✝ погибла</span>'}</h3>
    <div class="bar"><div style="width:${Math.max(0, (c.energy / maxE) * 100)}%"></div></div>
    <table>
      <tr><td>Состояние</td><td>${c.alive ? states[c.state] : '—'}</td></tr>
      <tr><td>Возраст</td><td>${Math.floor(c.age / DAY)} дн.</td></tr>
      <tr><td>Поколение</td><td>${c.generation}</td></tr>
      <tr><td>Детей / живых потомков</td><td>${c.children} / <b class="gold">${family.size}</b></td></tr>
      ${c.species !== 'herb' ? `<tr><td>Добыча</td><td>${c.kills}</td></tr>` : ''}
      ${geneRows(c.genes, parent?.genes)}
    </table>
    ${parent ? '<p class="muted small">▲▼ — мутации относительно родителя</p>' : ''}`;

  if (c.genes.brain && c.activations) {
    brainCanvas.hidden = false;
    drawBrain(brainCanvas, c.genes.brain, c.activations);
  } else brainCanvas.hidden = true;

  const line = world.lineage(c.id, 10);
  lineageEl.innerHTML = line.length
    ? `<h4>Родословная</h4><ol class="lineage">${line
        .map(
          (a) =>
            `<li data-id="${a.id}"><i style="background:hsl(${a.genes.hue},60%,55%)"></i>#${a.id} · пок. ${a.generation} · скор. ${a.genes.speed.toFixed(2)} · разм. ${a.genes.size.toFixed(1)}${
              a.died !== null ? '' : ' <b class="gold">жив</b>'
            }</li>`,
        )
        .join('')}${line[line.length - 1].parentId === null ? '<li class="muted">— основатель рода</li>' : '<li class="muted">…</li>'}</ol>`
    : '<p class="muted small">Основатель рода — предков нет.</p>';
}

// клик по предку в родословной — выбрать его, если ещё жив
$('lineage').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li[data-id]') as HTMLElement | null;
  if (!li) return;
  const alive = world.creatures.find((c) => c.id === Number(li.dataset.id));
  if (alive) select(alive);
});

// ---------- главный цикл ----------
const chart = $<HTMLCanvasElement>('chart');
const geneChart = $<HTMLCanvasElement>('gene-chart');
let frame = 0;
function loop(): void {
  if (!paused) for (let i = 0; i < speed; i++) world.step();
  if (selected && !selected.alive) family = new Set([...family].filter((c) => c.alive));
  renderer.draw(selected, family);
  if (frame++ % 10 === 0) {
    renderPanel();
    drawPopulation(chart, world);
    drawGeneHistory(geneChart, world, gene);
  } else if (selected?.genes.brain && selected.activations && !paused) {
    // мозг перерисовываем чаще — так видно, как он «думает»
    drawBrain($<HTMLCanvasElement>('brain'), selected.genes.brain, selected.activations);
  }
  requestAnimationFrame(loop);
}
loop();
