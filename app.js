/* app.js — UI for the scheduling bench.
   All rendering is percent-positioned off one simulated run; editing anything
   recomputes instantly. Playback adds a playhead over the same DOM. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const E = window.Engine;

  // ---------- state ----------
  const state = {
    procs: [],            // {pid, arrival, burst, priority, slot} — slot is the 1-8 color identity
    algo: 'fcfs',
    quantum: 2,
    ctxSwitch: 0,
    preemptive: false,
    t: 0,                  // playback clock
    playing: false,
  };
  let sim = null;          // last Engine.simulate() result
  let segEls = [];         // [{el, seg}] for playback painting
  let pidCounter = 0;

  const SLOTS = ['--p1', '--p2', '--p3', '--p4', '--p5', '--p6', '--p7', '--p8'];
  const fmt = v => String(Math.round(v * 100) / 100);
  const eps = 1e-9;

  // ---------- presets (classic teaching workloads) ----------
  const PRESETS = [
    {
      name: 'The convoy effect',
      what: 'One long job at the front stalls every short job behind it',
      algo: 'fcfs',
      procs: [[0, 12, 2], [1, 2, 1], [2, 3, 1], [3, 1, 3]]
    },
    {
      name: 'Textbook classic',
      what: 'The Galvin-example workload the engine tests are written against',
      algo: 'srtf',
      procs: [[0, 7, 2], [2, 4, 1], [4, 1, 3], [5, 4, 2]]
    },
    {
      name: 'Preemption pressure',
      what: 'Tight arrivals make SRTF and round robin chop constantly',
      algo: 'srtf',
      procs: [[0, 9, 3], [1, 5, 2], [2, 1, 1], [3, 4, 2], [4, 2, 1]]
    },
    {
      name: 'Round-robin fairness',
      what: 'Four equal jobs taking turns at quantum 2',
      algo: 'rr',
      quantum: 2,
      procs: [[0, 4, 1], [0, 4, 1], [0, 4, 1], [0, 4, 1]]
    }
  ];

  const ALGO_NOTES = {
    fcfs: 'First come, first served. Jobs run in arrival order. Simple and predictable, but one long job at the front stalls everything behind it.',
    sjf: 'Shortest job first, without preemption. Among waiting jobs, the smallest burst runs next. Excellent averages, but a stream of short jobs can starve a long one.',
    srtf: 'Shortest remaining time first — SJF with preemption. The moment a shorter job arrives, it interrupts whatever is running.',
    prio: 'Priority scheduling. The lowest priority number goes first. Turn preemption on to let a higher-priority arrival interrupt the running job.',
    rr: 'Round robin. Each job runs for one quantum, then moves to the back of the line. No starvation, at the price of more handoffs.'
  };

  // ---------- helpers ----------
  const nextPid = () => {
    const used = new Set(state.procs.map(p => p.pid));
    for (let i = 1; i <= 99; i++) if (!used.has('P' + i)) return 'P' + i;
    return 'P' + (++pidCounter);
  };
  const nextSlot = () => {
    const used = new Set(state.procs.map(p => p.slot));
    for (let s = 1; s <= 8; s++) if (!used.has(s)) return s;
    return 1;
  };
  const setWorkload = rows => {
    state.procs = rows.map((r, i) => ({
      pid: 'P' + (i + 1),
      arrival: r[0], burst: r[1], priority: r[2],
      slot: i + 1
    }));
    pidCounter = state.procs.length;
  };

  const engineInput = () => ({
    processes: state.procs,
    algorithm: state.algo,
    quantum: state.quantum,
    ctxSwitch: state.ctxSwitch,
    preemptive: state.preemptive
  });

  const rerun = () => {
    sim = state.procs.length ? E.simulate(engineInput()) : null;
  };

  // ---------- theme ----------
  const storedTheme = localStorage.getItem('dispatch-theme');
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;
  const isDark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const paintThemeBtn = () => { $('themeToggle').classList.toggle('on', isDark()); };
  $('themeToggle').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('dispatch-theme', next);
    paintThemeBtn();
  });

  // ---------- tooltip ----------
  const tip = $('tip');
  const showTip = (el) => {
    const s = el._seg;
    let t1, t2;
    if (s.kind === 'run') { t1 = s.pid; t2 = `runs from t ${s.start} to t ${s.end}, ${s.end - s.start} unit${s.end - s.start === 1 ? '' : 's'}`; }
    else if (s.kind === 'idle') { t1 = 'CPU idle'; t2 = `t ${s.start} to t ${s.end}`; }
    else { t1 = 'Context switch'; t2 = `t ${s.start} to t ${s.end}`; }
    tip.innerHTML = `<div class="t1"></div><div class="t2"></div>`;
    tip.firstChild.textContent = t1;
    tip.lastChild.textContent = t2;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, innerWidth - tw - 8));
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  const hideTip = () => { tip.hidden = true; };

  // ---------- gantt ----------
  const niceStep = total => {
    const raw = total / 9;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.5))));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
    return 10 * pow;
  };

  const segLabel = (s, laneW, total) => {
    const px = (s.end - s.start) / total * laneW;
    const name = s.kind === 'run' ? s.pid : (s.kind === 'idle' ? 'idle' : 'switch');
    return px >= 40 ? name : '';
  };

  const segAria = s =>
    s.kind === 'run'
      ? `${s.pid} runs from t ${s.start} to t ${s.end}, ${s.end - s.start} units`
      : s.kind === 'idle'
        ? `CPU idle from t ${s.start} to t ${s.end}`
        : `Context switch from t ${s.start} to t ${s.end}`;

  function renderGantt() {
    const host = $('ganttHost');
    segEls = [];
    if (!sim) {
      host.innerHTML = '<p class="panel-note">No processes yet. Add one or load a preset.</p>';
      return;
    }
    const total = sim.summary.totalTime;
    const frag = document.createDocumentFragment();

    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const p of state.procs) {
      const key = document.createElement('span');
      key.className = 'key';
      key.innerHTML = `<span class="sw" style="background:var(--p${p.slot})"></span><span class="mono"></span>`;
      key.lastChild.textContent = p.pid;
      legend.appendChild(key);
    }
    legend.insertAdjacentHTML('beforeend',
      '<span class="key"><span class="sw idle"></span>idle</span>' +
      '<span class="key"><span class="sw ctx"></span>context switch</span>');
    frag.appendChild(legend);

    const g = document.createElement('div');
    g.className = 'gantt';
    g.id = 'gantt';

    const lane = document.createElement('div');
    lane.className = 'lane-row';
    lane.setAttribute('role', 'img');
    lane.setAttribute('aria-label', 'Gantt timeline of CPU execution');
    for (const s of sim.segments) {
      const el = document.createElement('div');
      el.className = 'seg ' + s.kind;
      el.style.left = (s.start / total * 100) + '%';
      el.style.width = ((s.end - s.start) / total * 100) + '%';
      if (s.kind === 'run') {
        el.style.background = `var(--p${state.procs.find(p => p.pid === s.pid).slot})`;
        el.tabIndex = 0;
      }
      el._seg = s;
      el.setAttribute('aria-label', segAria(s));
      lane.appendChild(el);
      segEls.push({ el, seg: s });
    }
    const ph = document.createElement('div');
    ph.className = 'playhead';
    lane.appendChild(ph);
    g.appendChild(lane);

    // time ruler
    const step = niceStep(total);
    const ruler = document.createElement('div');
    ruler.className = 'ruler';
    ruler.setAttribute('aria-hidden', 'true');
    for (let t = 0; t <= total + eps; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (t / total * 100) + '%';
      ruler.appendChild(tick);
      const num = document.createElement('div');
      num.className = 'tick-num';
      num.textContent = Math.round(t * 10) / 10;
      const at = t / total;
      if (at < 0.02) num.classList.add('start');
      else if (at > 0.98) num.classList.add('end');
      num.style.left = (at * 100) + '%';
      ruler.appendChild(num);
    }
    const half = step / 2;
    if (half >= 0.5 && (total / half) <= 40) {
      for (let t = half; t < total - eps; t += step) {
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = (t / total * 100) + '%';
        ruler.appendChild(tick);
      }
    }
    g.appendChild(ruler);

    frag.appendChild(g);
    host.replaceChildren(frag);

    // pid labels only where they fit (relief rule for low-contrast hues)
    const laneW = lane.clientWidth;
    for (const { el, seg } of segEls) {
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = segLabel(seg, laneW, total);
      if (!lbl.textContent) lbl.classList.add('off');
      el.appendChild(lbl);
    }
  }

  // ---------- metrics ----------
  function renderMetrics() {
    const body = $('metricBody'), foot = $('metricFoot');
    if (!sim) {
      body.innerHTML = '<tr><td colspan="7" class="panel-note">No processes.</td></tr>';
      foot.innerHTML = '';
      return;
    }
    body.innerHTML = '';
    for (const r of sim.results) {
      const slot = state.procs.find(p => p.pid === r.pid)?.slot ?? 1;
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><span class="pid-chip" style="--chip:var(--p${slot})"></span></td>` +
        ['arrival', 'burst', 'completion', 'turnaround', 'waiting', 'response']
          .map(k => `<td class="num-cell">${r[k]}</td>`).join('');
      tr.firstChild.firstChild.textContent = r.pid;
      body.appendChild(tr);
    }
    const s = sim.summary;
    foot.innerHTML =
      `<tr><td>Average</td><td></td><td></td><td></td>` +
      `<td class="num-cell">${fmt(s.avgTurnaround)}</td>` +
      `<td class="num-cell">${fmt(s.avgWaiting)}</td>` +
      `<td class="num-cell">${fmt(s.avgResponse)}</td></tr>`;
  }

  // ---------- comparison ----------
  function renderCompare() {
    const body = $('cmpBody');
    if (!sim) { body.innerHTML = '<tr><td colspan="7" class="panel-note">No processes.</td></tr>'; return; }
    const rows = E.compare({ processes: state.procs, quantum: state.quantum, ctxSwitch: state.ctxSwitch });
    const best = {
      avgWaiting: Math.min(...rows.map(r => r.summary.avgWaiting)),
      avgTurnaround: Math.min(...rows.map(r => r.summary.avgTurnaround)),
      avgResponse: Math.min(...rows.map(r => r.summary.avgResponse)),
      utilization: Math.max(...rows.map(r => r.summary.utilization)),
      switches: Math.min(...rows.map(r => r.summary.switches)),
      totalTime: Math.min(...rows.map(r => r.summary.totalTime))
    };
    body.innerHTML = '';
    rows.forEach(r => {
      const s = r.summary;
      const label = r.key === 'rr' ? `Round robin (q ${state.quantum})` : r.label;
      const td = (v, key) => `<td class="num-cell${v === best[key] ? ' cmp-best' : ''}">${fmt(v)}</td>`;
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.dataset.key = r.key;
      tr.dataset.preempt = String(!!r.preemptive);
      const isCurrent = r.key === state.algo && (r.key !== 'prio' || String(state.preemptive) === tr.dataset.preempt);
      if (isCurrent) tr.className = 'current';
      tr.innerHTML =
        `<td>${label}</td>` +
        td(s.avgWaiting, 'avgWaiting') + td(s.avgTurnaround, 'avgTurnaround') + td(s.avgResponse, 'avgResponse') +
        `<td class="num-cell${s.utilization === best.utilization ? ' cmp-best' : ''}">${Math.round(s.utilization * 1000) / 10}%</td>` +
        td(s.switches, 'switches') + td(s.totalTime, 'totalTime');
      body.appendChild(tr);
    });
  }

  // ---------- process table ----------
  function renderProcTable(rebuild) {
    const body = $('procBody');
    if (rebuild) {
      body.innerHTML = '';
      state.procs.forEach((p, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><span class="pid-chip" style="--chip:var(--p${p.slot})"><input class="pid-in" data-i="${i}" type="text" value=""></span></td>` +
          `<td><input data-i="${i}" data-k="arrival" type="number" min="0" step="1"></td>` +
          `<td><input data-i="${i}" data-k="burst" type="number" min="1" step="1"></td>` +
          `<td><input data-i="${i}" data-k="priority" type="number" min="0" step="1"></td>` +
          `<td><button class="rm-btn" data-i="${i}" type="button" aria-label="Remove process ${p.pid}">&times;</button></td>`;
        tr.querySelector('.pid-in').value = p.pid;
        for (const k of ['arrival', 'burst', 'priority']) tr.querySelector(`[data-k="${k}"]`).value = p[k];
        body.appendChild(tr);
      });
      $('addProc').disabled = state.procs.length >= 8;
    }
  }

  const parseNum = (raw, min) => {
    if (!/^\s*-?\d+\s*$/.test(raw)) return NaN;
    const v = parseInt(raw, 10);
    return v < min ? NaN : v;
  };

  // ---------- algo controls ----------
  function paintTabs() {
    for (const b of document.querySelectorAll('.tab')) {
      b.setAttribute('aria-selected', b.dataset.algo === state.algo ? 'true' : 'false');
    }
    $('algoNote').textContent = ALGO_NOTES[state.algo];
    $('quantumParam').style.display = state.algo === 'rr' ? '' : 'none';
    document.querySelector('.param.check').style.display = state.algo === 'prio' ? '' : 'none';
  }

  // ---------- playback ----------
  let raf = null, lastTs = null, playSpeed = 1;

  const total = () => sim ? sim.summary.totalTime : 0;

  const segAt = t => sim ? sim.segments.find(s => s.start < t + eps && s.end > t + eps) : null;

  function paintPlayback() {
    const T = total();
    if (!T) return;
    const g = $('gantt');
    if (!g) return;
    g.classList.add('playback');
    const cur = segAt(state.t);
    for (const { el, seg } of segEls) {
      el.classList.toggle('lit', seg.start < state.t + eps);
      // the segment under the playhead reveals only what has executed
      if (cur && seg === cur && seg.kind === 'run') {
        const done = (state.t - seg.start) / (seg.end - seg.start);
        el.style.clipPath = `inset(0 ${(1 - done) * 100}% 0 0)`;
      } else {
        el.style.clipPath = '';
      }
    }
    const ph = g.querySelector('.playhead');
    ph.style.left = (state.t / T * 100) + '%';

    const now = $('cpuNow');
    if (cur && cur.kind === 'run') { now.textContent = cur.pid; now.classList.add('on'); }
    else if (cur && cur.kind === 'ctx') { now.textContent = 'switching'; now.classList.remove('on'); }
    else { now.textContent = 'idle'; now.classList.remove('on'); }
    $('clockReadout').textContent = `t = ${Math.round(state.t * 10) / 10}`;
  }

  function finishPlayback() {
    state.playing = false;
    state.t = total();
    lastTs = null;
    raf = null;
    const btn = $('playBtn');
    btn.classList.remove('playing');
    $('playLabel').textContent = 'Play';
    const g = $('gantt');
    if (g) g.classList.remove('playback');
    $('cpuNow').textContent = 'done';
    $('cpuNow').classList.remove('on');
    $('clockReadout').textContent = `t = ${total()}`;
    renderGantt(); // full view, labels refit
  }

  function tick(ts) {
    if (!state.playing) { raf = null; lastTs = null; return; }
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    state.t = Math.min(total(), state.t + playSpeed * dt);
    paintPlayback();
    if (state.t >= total() - eps) { finishPlayback(); return; }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!sim) return;
    if (state.t >= total() - eps) state.t = 0;
    const dur = Math.min(7, Math.max(2.2, total() * 0.28));
    playSpeed = total() / dur;
    state.playing = true;
    $('playBtn').classList.add('playing');
    $('playLabel').textContent = 'Pause';
    lastTs = null;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    $('playBtn').classList.remove('playing');
    $('playLabel').textContent = 'Play';
  }

  function step() {
    if (!sim) return;
    pause();
    const bounds = new Set([0]);
    for (const s of sim.segments) { bounds.add(s.start); bounds.add(s.end); }
    const next = [...bounds].sort((a, b) => a - b).find(b => b > state.t + eps);
    state.t = next === undefined ? total() : next;
    if (state.t >= total() - eps) finishPlayback();
    else paintPlayback();
  }

  // ---------- render everything ----------
  function renderAll(opts) {
    const { animate = false } = opts || {};
    rerun();
    renderGantt();
    renderMetrics();
    renderCompare();
    if (animate) play(); else { pause(); if (sim) { state.t = 0; paintPlaybackAtRest(); } }
  }

  const paintPlaybackAtRest = () => {
    const g = $('gantt');
    if (g) g.classList.remove('playback');
    $('cpuNow').textContent = 'idle';
    $('cpuNow').classList.remove('on');
    $('clockReadout').textContent = 't = 0';
    state.t = 0;
  };

  // ---------- events ----------
  $('procBody').addEventListener('input', e => {
    const inp = e.target;
    const i = +inp.dataset.i;
    const p = state.procs[i];
    if (!p) return;
    if (inp.classList.contains('pid-in')) {
      const v = inp.value.trim();
      if (v) p.pid = v;
      inp.classList.toggle('bad', !v);
    } else {
      const v = parseNum(inp.value, inp.dataset.k === 'burst' ? 1 : 0);
      inp.classList.toggle('bad', isNaN(v));
      if (!isNaN(v)) p[inp.dataset.k] = v;
    }
    pause();
    rerun();
    renderGantt(); renderMetrics(); renderCompare();
  });

  $('procBody').addEventListener('change', e => {
    const inp = e.target;
    const i = +inp.dataset.i;
    const p = state.procs[i];
    if (!p || inp.classList.contains('pid-in')) return;
    inp.value = p[inp.dataset.k];
    inp.classList.remove('bad');
  });

  $('procBody').addEventListener('click', e => {
    if (!e.target.classList.contains('rm-btn')) return;
    state.procs.splice(+e.target.dataset.i, 1);
    pause();
    renderProcTable(true);
    renderAll();
  });

  $('addProc').addEventListener('click', () => {
    if (state.procs.length >= 8) return;
    state.procs.push({ pid: nextPid(), arrival: 0, burst: 4, priority: 2, slot: nextSlot() });
    pause();
    renderProcTable(true);
    renderAll();
  });

  $('randomize').addEventListener('click', () => {
    const n = 3 + Math.floor(Math.random() * 4);
    const rows = Array.from({ length: n }, (_, i) =>
      [i === 0 ? 0 : Math.floor(Math.random() * 8), 1 + Math.floor(Math.random() * 9), 1 + Math.floor(Math.random() * 4)]);
    rows.sort((a, b) => a[0] - b[0]);
    setWorkload(rows);
    pause();
    renderProcTable(true);
    renderAll();
  });

  $('quantum').addEventListener('input', e => {
    const v = parseNum(e.target.value, 1);
    e.target.classList.toggle('bad', isNaN(v));
    if (!isNaN(v)) state.quantum = v;
    pause(); rerun(); renderGantt(); renderMetrics(); renderCompare();
  });
  $('quantum').addEventListener('change', e => { e.target.value = state.quantum; e.target.classList.remove('bad'); });

  $('ctxSwitch').addEventListener('input', e => {
    const v = parseNum(e.target.value, 0);
    e.target.classList.toggle('bad', isNaN(v));
    if (!isNaN(v)) state.ctxSwitch = v;
    pause(); rerun(); renderGantt(); renderMetrics(); renderCompare();
  });
  $('ctxSwitch').addEventListener('change', e => { e.target.value = state.ctxSwitch; e.target.classList.remove('bad'); });

  $('preemptive').addEventListener('change', e => {
    state.preemptive = e.target.checked;
    pause(); rerun(); renderGantt(); renderMetrics(); renderCompare();
  });

  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.algo = b.dataset.algo;
    pause();
    paintTabs();
    renderAll({ animate: false });
  });

  $('playBtn').addEventListener('click', () => state.playing ? pause() : play());
  $('stepBtn').addEventListener('click', step);

  $('cmpBody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    state.algo = tr.dataset.key;
    if (tr.dataset.key === 'prio') state.preemptive = tr.dataset.preempt === 'true';
    $('preemptive').checked = state.preemptive;
    pause();
    paintTabs();
    renderAll({ animate: false });
  });
  $('cmpBody').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    e.preventDefault();
    tr.click();
  });

  // tooltip: hover + keyboard focus show the same content
  $('ganttHost').addEventListener('mouseover', e => { const s = e.target.closest('.seg'); if (s) showTip(s); });
  $('ganttHost').addEventListener('mouseout', e => { if (e.target.closest('.seg')) hideTip(); });
  $('ganttHost').addEventListener('focusin', e => { const s = e.target.closest('.seg'); if (s) showTip(s); });
  $('ganttHost').addEventListener('focusout', hideTip);
  addEventListener('scroll', hideTip, true);

  // labels depend on rendered pixel width — refit on resize (not mid-playback)
  let resizeTimer = null;
  addEventListener('resize', () => {
    if (!sim || state.playing) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGantt, 150);
  });

  // presets
  const presetList = $('presetList');
  PRESETS.forEach(p => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="name"></span><span class="what"></span>`;
    b.firstChild.textContent = p.name;
    b.lastChild.textContent = p.what;
    b.addEventListener('click', () => {
      setWorkload(p.procs);
      state.algo = p.algo;
      if (p.quantum) { state.quantum = p.quantum; $('quantum').value = p.quantum; }
      pause();
      paintTabs();
      renderProcTable(true);
      renderAll({ animate: true });
    });
    li.appendChild(b);
    presetList.appendChild(li);
  });

  // ---------- init ----------
  $('procTable').classList.add('proc-table');
  paintThemeBtn();
  setWorkload(PRESETS[0].procs);
  state.algo = PRESETS[0].algo;
  paintTabs();
  renderProcTable(true);
  renderAll({ animate: true });
})();
