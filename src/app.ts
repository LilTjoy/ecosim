import './style.css';
import './planet/planet.css';
import { DrakeView } from './planet/drakeView';
import { McView } from './planet/mcView';
import { PlanetView } from './planet/planetView';
import { SurfaceView } from './surface/view';
import { CompareView } from './compare/compareView';
import { isNatural } from './compare/worlds';
import './surface/surface.css';
import { LearnView } from './learn/view';
import './learn/learn.css';

type ViewName = 'planet' | 'mc' | 'drake' | 'eco' | 'compare' | 'learn';
const VIEWS: ViewName[] = ['planet', 'mc', 'drake', 'eco', 'compare', 'learn'];

const el = (id: string) => document.getElementById(id)!;

const planet = new PlanetView(el('view-planet'));
const mc = new McView(el('view-mc'));
const drake = new DrakeView(el('view-drake'));
const surface = new SurfaceView(el('view-eco'));
surface.onBack = () => show('planet');
planet.onDescend = (env, seed) => {
  if (!surface.confirmNewWorld()) return; // ветки этого мира пропали бы — игрок передумал
  surface.setEnv(env, seed, true);
  show('eco');
};

// «Сравнение миров» создаём при первом заходе (после показа вкладки — чтобы у глобусов был размер)
let compare: CompareView | null = null;
function ensureCompare(): CompareView {
  if (compare) return compare;
  const c = new CompareView(el('view-compare'));
  c.onOpen = (p, pr) => {
    planet.open(p, pr);
    show('planet');
  };
  c.getLucky = () => mc.stats.lucky.map((l) => l.params);
  c.getPlanet = () => planet.current;
  c.onNeedMc = () => show('mc');
  c.onFact = (id) => learn.markSeen('compare', id);
  return (compare = c);
}
planet.onCompare = (p) => {
  show('compare');
  if (!isNatural(p)) ensureCompare().setSlot(3, { id: 'mine', name: `Мир #${p.seed}`, icon: '🪐', color: '#b39ddb', params: { ...p } });
};

mc.onStats = (s, preset) => drake.setStats(s, preset);
mc.onOpen = (params, preset) => {
  planet.open(params, preset);
  show('planet');
};
const learn = new LearnView(el('view-learn'), { planet, mc, drake, surface, show, openCompareFact: (id) => ensureCompare().openFact(id) });
planet.onFact = (id) => learn.markSeen('planet', id);
surface.observeFacts((id) => learn.markSeen('surface', id));

function show(name: ViewName): void {
  for (const v of VIEWS) el(`view-${v}`).hidden = v !== name;
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  planet.active = name === 'planet';
  drake.active = name === 'drake';
  surface.active = name === 'eco';
  if (name === 'compare') ensureCompare();
  if (compare) compare.active = name === 'compare';
  learn.active = name === 'learn';
  learn.onShow(name);
  // Монте-Карло запускаем при первом заходе на вкладку миров или Дрейка
  if ((name === 'mc' || name === 'drake') && !mc.started) mc.run();
  if (location.hash.slice(1).split('/')[0] !== name) history.replaceState(null, '', `#${name}`); // #learn/<карточка> сохраняется
  window.dispatchEvent(new Event('resize'));
}

document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view as ViewName)));
const [initial, sub] = location.hash.slice(1).split('/') as [ViewName, string?];
show(VIEWS.includes(initial) ? initial : 'planet');
if (initial === 'learn' && sub) learn.openCard(sub);
learn.restore();
window.addEventListener('hashchange', () => {
  const [v, card] = location.hash.slice(1).split('/');
  if (v !== 'learn' || !card) return;
  show('learn');
  learn.openCard(card);
});
