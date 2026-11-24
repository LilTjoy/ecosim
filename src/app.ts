import './style.css';
import './planet/planet.css';
import { DrakeView } from './planet/drakeView';
import { McView } from './planet/mcView';
import { PlanetView } from './planet/planetView';
import { SurfaceView } from './surface/view';
import './surface/surface.css';
import { LearnView } from './learn/view';
import './learn/learn.css';

type ViewName = 'planet' | 'mc' | 'drake' | 'eco' | 'learn';

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

mc.onStats = (s, preset) => drake.setStats(s, preset);
mc.onOpen = (params, preset) => {
  planet.open(params, preset);
  show('planet');
};
const learn = new LearnView(el('view-learn'), { planet, mc, drake, surface, show });
planet.onFact = (id) => learn.markSeen('planet', id);
surface.observeFacts((id) => learn.markSeen('surface', id));

function show(name: ViewName): void {
  for (const v of ['planet', 'mc', 'drake', 'eco', 'learn'] as ViewName[]) el(`view-${v}`).hidden = v !== name;
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  planet.active = name === 'planet';
  drake.active = name === 'drake';
  surface.active = name === 'eco';
  learn.active = name === 'learn';
  learn.onShow(name);
  // Монте-Карло запускаем при первом заходе на вкладку миров или Дрейка
  if ((name === 'mc' || name === 'drake') && !mc.started) mc.run();
  if (location.hash.slice(1).split('/')[0] !== name) history.replaceState(null, '', `#${name}`); // #learn/<карточка> сохраняется
  window.dispatchEvent(new Event('resize'));
}

document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view as ViewName)));
const [initial, sub] = location.hash.slice(1).split('/') as [ViewName, string?];
show(['planet', 'mc', 'drake', 'eco', 'learn'].includes(initial) ? initial : 'planet');
if (initial === 'learn' && sub) learn.openCard(sub);
learn.restore();
window.addEventListener('hashchange', () => {
  const [v, card] = location.hash.slice(1).split('/');
  if (v !== 'learn' || !card) return;
  show('learn');
  learn.openCard(card);
});
