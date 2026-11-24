import './style.css';
import './planet/planet.css';
import { DrakeView } from './planet/drakeView';
import { McView } from './planet/mcView';
import { PlanetView } from './planet/planetView';
import { SurfaceView } from './surface/view';
import './surface/surface.css';

type ViewName = 'planet' | 'mc' | 'drake' | 'eco';

const el = (id: string) => document.getElementById(id)!;

const planet = new PlanetView(el('view-planet'));
const mc = new McView(el('view-mc'));
const drake = new DrakeView(el('view-drake'));
const surface = new SurfaceView(el('view-eco'));
surface.onBack = () => show('planet');
planet.onDescend = (env, seed) => {
  surface.setEnv(env, seed);
  show('eco');
};
let mcStarted = false;

mc.onStats = (s, preset) => drake.setStats(s, preset);
mc.onOpen = (params, preset) => {
  planet.open(params, preset);
  show('planet');
};

function show(name: ViewName): void {
  for (const v of ['planet', 'mc', 'drake', 'eco'] as ViewName[]) el(`view-${v}`).hidden = v !== name;
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  planet.active = name === 'planet';
  drake.active = name === 'drake';
  surface.active = name === 'eco';
  // Монте-Карло запускаем при первом заходе на вкладку миров или Дрейка
  if ((name === 'mc' || name === 'drake') && !mcStarted) {
    mcStarted = true;
    mc.run();
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.dispatchEvent(new Event('resize'));
}

document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view as ViewName)));
const initial = location.hash.slice(1) as ViewName;
show(['planet', 'mc', 'drake', 'eco'].includes(initial) ? initial : 'planet');
