import { EARTH } from '../planet/model';
import { EARTH_ENV } from '../sim/world';
import type { Card } from './catalog';
import type { LearnCtx } from './engine';

/** Подпись кнопки «посмотреть в симуляции». */
export function linkLabel(card: Card): string {
  const l = card.link;
  if (!l) return '';
  if (l.label) return l.label;
  if (l.view === 'mc') return '▶ Открыть «10 000 миров»';
  if (l.view === 'drake') return '▶ Открыть уравнение Дрейка';
  if (l.view === 'lesson') return '🎓 Пройти урок';
  return '▶ Посмотреть в симуляции';
}

/** Открыть симуляцию в том месте, о котором карточка. */
export function goLink(ctx: LearnCtx, card: Card, startLesson: (id: string) => void): void {
  const l = card.link;
  if (!l) return;
  if (l.view === 'planet') {
    ctx.planet.open({ ...EARTH, ...l.params }, 'realist');
    const r = ctx.planet.snapshot().result;
    const id = l.event ?? card.key;
    const ev = r.events.find((e) => e.id === id && (!l.match || e.text.includes(l.match)));
    ctx.planet.seek(ev?.t ?? l.t ?? 0, false);
    ctx.show('planet');
    ctx.planet.showFact(card.key);
  } else if (l.view === 'eco') {
    if (l.env) ctx.surface.newWorld({ ...EARTH_ENV, ...l.env, name: l.envName ?? 'Опыт' }, 42);
    ctx.show('eco');
    if (l.tab) ctx.surface.showTab(l.tab, l.gene);
    ctx.surface.openFact(card.key);
  } else if (l.view === 'lesson') startLesson(l.id);
  else ctx.show(l.view);
}
