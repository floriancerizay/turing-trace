// Page d'administration : statistiques agrégées du serveur (GET /api/stats, jeton Bearer).
import { t, getLang, setLang, applyI18n } from './i18n.js';

const $ = (s) => document.querySelector(s);
let last = null; // dernières statistiques reçues, pour réafficher dans l'autre langue

/** Barres horizontales : libellé, barre proportionnelle au maximum, valeur. */
function bars(el, rows) {
  el.replaceChildren();
  if (!rows.length) {
    el.textContent = t('adm.none');
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const label = document.createElement('span');
    label.className = 'admin-label';
    label.textContent = r.label;
    const track = document.createElement('span');
    track.className = 'admin-track';
    const fill = document.createElement('span');
    fill.className = 'admin-fill';
    fill.style.width = `${(r.count / max) * 100}%`;
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'admin-value';
    value.textContent = r.count;
    row.append(label, track, value);
    el.append(row);
  }
}

function render() {
  if (!last) return;
  $('#results').hidden = false;
  $('#observeNote').hidden = !last.observe;
  $('#windowNote').textContent = t('adm.window', { h: last.windowHours });
  $('#total').textContent = last.total;
  $('#accepted').textContent = last.accepted;
  $('#rate').textContent =
    last.acceptanceRate == null ? '–' : `${Math.round(last.acceptanceRate * 100)} %`;
  bars(
    $('#histogram'),
    last.histogram.map((b) => ({ label: `${b.from}–${b.to}`, count: b.count })),
  );
  bars(
    $('#rules'),
    last.topRules.map((r) => ({ label: t('rl.' + r.id), count: r.count })),
  );
  // Le libellé de l'étape « seuil » contient le seuil réel ({min}), inconnu ici : libellé générique.
  bars(
    $('#steps'),
    last.topSteps.map((r) => ({
      label: r.id === 'threshold' ? t('adm.threshold') : t('step.' + r.id),
      count: r.count,
    })),
  );
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#error').textContent = '';
  try {
    const r = await fetch('api/stats', {
      headers: { Authorization: `Bearer ${$('#token').value}` },
      cache: 'no-store',
    });
    if (r.status === 401) {
      $('#error').textContent = t('adm.e401');
      return;
    }
    if (!r.ok) {
      $('#error').textContent = t('adm.e404');
      return;
    }
    last = await r.json();
    render();
  } catch {
    $('#error').textContent = t('adm.eNet');
  }
});

document.querySelectorAll('[data-lang]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.lang === getLang()) return;
    setLang(b.dataset.lang);
    applyI18n();
    render();
  }),
);
applyI18n();
