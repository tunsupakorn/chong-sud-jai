// Small, dependency-free charts. Single-hue marks (magnitude), text in ink tokens.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// rows: [{ emoji, name, amount }] sorted desc
export function categoryBars(rows, fmt, kind) {
  if (!rows.length) return '<p class="muted center pad">ยังไม่มีข้อมูลในเดือนนี้</p>';
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const max = rows[0].amount;
  return `<ul class="catbars ${kind}">${rows.map(r => {
    const pct = total ? Math.round(r.amount / total * 100) : 0;
    return `<li>
      <div class="cb-head"><span class="cb-emoji" aria-hidden="true">${r.emoji}</span><span class="cb-name">${esc(r.name)}</span>
      <span class="cb-val num">${fmt(r.amount)}</span><span class="cb-pct num">${pct}%</span></div>
      <div class="cb-track"><div class="cb-fill" style="width:${Math.max(2, r.amount / max * 100)}%"></div></div></li>`;
  }).join('')}</ul>`;
}

// values: number per day; labels: tooltip label per day
// xTicks (optional): [{ i, label }] for the x axis; default = day numbers 1, 8, 15, 22, last
export function dailyColumns(values, labels, fmt, kind, xTicks) {
  const top = niceMax(Math.max(0, ...values));
  const short = n => n >= 1000 ? (n / 1000).toLocaleString('th-TH', { maximumFractionDigits: 1 }) + 'k' : String(n);
  const n = values.length;
  const ticks = xTicks || [1, 8, 15, 22, n].map(t => ({ i: t - 1, label: String(t) }));
  return `<div class="cols ${kind}">
    <div class="cols-plot">
      <div class="cols-grid" aria-hidden="true">
        <span style="bottom:100%"><i>${short(top)}</i></span>
        <span style="bottom:50%"><i>${short(top / 2)}</i></span>
        <span style="bottom:0"><i>0</i></span>
      </div>
      <div class="cols-bars">
        ${values.map((v, i) => `<div class="col" tabindex="0" data-tip="${esc(labels[i])} · ${esc(fmt(v))}" aria-label="${esc(labels[i])} ${esc(fmt(v))}">
          <div class="col-bar${v ? '' : ' zero'}" style="height:${v ? Math.max(1.5, v / top * 100) : 0}%"></div></div>`).join('')}
      </div>
      <div class="tip" hidden></div>
    </div>
    <div class="cols-x" aria-hidden="true">${ticks.map(t => `<span style="left:${(t.i + 0.5) / n * 100}%">${esc(t.label)}</span>`).join('')}</div>
  </div>`;
}

export function bindColumnTips(root) {
  root.querySelectorAll('.cols').forEach(chart => {
    const tip = chart.querySelector('.tip');
    const plot = chart.querySelector('.cols-plot');
    const show = col => {
      chart.querySelectorAll('.col.on').forEach(c => c.classList.remove('on'));
      col.classList.add('on');
      tip.textContent = col.dataset.tip;
      tip.hidden = false;
      const pr = plot.getBoundingClientRect(), cr = col.getBoundingClientRect();
      const x = cr.left + cr.width / 2 - pr.left;
      tip.style.left = Math.min(Math.max(x, 60), pr.width - 60) + 'px';
    };
    const hide = () => { tip.hidden = true; chart.querySelectorAll('.col.on').forEach(c => c.classList.remove('on')); };
    chart.querySelectorAll('.col').forEach(col => {
      col.addEventListener('pointerenter', () => show(col));
      col.addEventListener('focus', () => show(col));
      col.addEventListener('click', () => show(col));
    });
    plot.addEventListener('pointerleave', hide);
    chart.addEventListener('focusout', e => { if (!chart.contains(e.relatedTarget)) hide(); });
  });
}
