/* engine.js — CPU scheduling engine.
   Pure functions, no DOM. Runs in the browser (window.Engine) and in Node (module.exports) for testing.

   Conventions:
   - All times are integers in arbitrary units.
   - Lower priority number = higher priority.
   - Context-switch cost is charged between two run slices of different processes
     that touch in time (idle gaps are free).
   - waiting = turnaround - burst (the standard textbook simplification).
*/
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICK_LIMIT = 100000; // ponytail: safety net against bad input, engine assumes integers >= 0

  function lex(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function simulate(opts) {
    const procs = opts.processes.map((p, i) => ({
      i,
      pid: p.pid || 'P' + (i + 1),
      arrival: p.arrival,
      burst: p.burst,
      priority: p.priority,
      remaining: p.burst
    }));
    const algo = opts.algorithm;
    const ctx = Math.max(0, +opts.ctxSwitch || 0);
    const preempt = !!opts.preemptive;
    const quantum = Math.max(1, Math.round(+opts.quantum) || 1);

    const segs = [];
    const firstRun = new Array(procs.length).fill(-1);
    const completion = new Array(procs.length).fill(-1);
    const unfinished = () => procs.filter(p => p.remaining > 0);

    let time = 0, done = 0, prevRun = null, guard = 0;
    // prevRun: pid of the most recent run slice (null after idle or at start).
    // A context switch is charged when a run slice of a different pid follows it.

    const push = (pid, start, end, kind) => {
      const last = segs[segs.length - 1];
      if (last && last.kind === kind && last.pid === pid && last.end === start) last.end = end;
      else segs.push({ pid: pid, start: start, end: end, kind: kind });
    };

    // --- queue-ordered algorithms: fcfs, sjf, srtf, prio ---
    const CMP = {
      fcfs: p => p.arrival,
      sjf: p => p.burst,
      srtf: p => p.remaining,
      prio: p => p.priority
    };

    function runOrdered() {
      const cmp = CMP[algo] || CMP.fcfs;
      const preemptive = algo === 'srtf' || (algo === 'prio' && preempt);
      let cur = null;
      while (done < procs.length) {
        if (++guard > TICK_LIMIT) throw new Error('simulation did not terminate');
        const ready = unfinished().filter(p => p.arrival <= time);
        if (!ready.length) {
          const next = Math.min.apply(null, unfinished().map(p => p.arrival));
          push(null, time, next, 'idle');
          time = next; cur = null; prevRun = null;
          continue;
        }
        let pick = null, pickKey = null;
        for (const p of ready) {
          // prefer the current process on ties so equal candidates don't thrash
          const key = [cmp(p), p === cur ? 0 : 1, p.arrival, p.i];
          if (pick === null || lex(key, pickKey) < 0) { pick = p; pickKey = key; }
        }
        if (pick !== cur) {
          if (prevRun !== null && prevRun !== pick.pid && ctx > 0) {
            push(null, time, time + ctx, 'ctx');
            time += ctx;
          }
          cur = pick;
          if (firstRun[pick.i] < 0) firstRun[pick.i] = time;
        }
        let len;
        if (!preemptive) {
          len = cur.remaining;
        } else {
          let nextArr = Infinity;
          for (const p of unfinished()) if (p.arrival > time && p.arrival < nextArr) nextArr = p.arrival;
          len = Math.min(cur.remaining, nextArr - time);
        }
        push(cur.pid, time, time + len, 'run');
        cur.remaining -= len; time += len; prevRun = cur.pid;
        if (cur.remaining === 0) { completion[cur.i] = time; done++; cur = null; }
      }
    }

    // --- round robin ---
    function runRR() {
      const queue = [];
      const enqueued = new Array(procs.length).fill(false);
      const enqueue = upto => {
        const fresh = procs
          .filter(p => !enqueued[p.i] && p.arrival <= upto && p.remaining > 0)
          .sort((a, b) => a.arrival - b.arrival || a.i - b.i);
        for (const p of fresh) { enqueued[p.i] = true; queue.push(p); }
      };
      enqueue(time);
      while (done < procs.length) {
        if (++guard > TICK_LIMIT) throw new Error('simulation did not terminate');
        if (!queue.length) {
          const next = Math.min.apply(null, unfinished().map(p => p.arrival));
          push(null, time, next, 'idle');
          time = next; prevRun = null;
          enqueue(time);
          continue;
        }
        const p = queue.shift();
        if (prevRun !== null && prevRun !== p.pid && ctx > 0) {
          push(null, time, time + ctx, 'ctx');
          time += ctx;
        }
        if (firstRun[p.i] < 0) firstRun[p.i] = time;
        const len = Math.min(p.remaining, quantum);
        push(p.pid, time, time + len, 'run');
        p.remaining -= len; time += len; prevRun = p.pid;
        enqueue(time); // arrivals during this slice queue ahead of the preempted job
        if (p.remaining === 0) { completion[p.i] = time; done++; }
        else queue.push(p);
      }
    }

    if (algo === 'rr') runRR(); else runOrdered();

    const results = procs.map(p => ({
      pid: p.pid,
      arrival: p.arrival,
      burst: p.burst,
      priority: p.priority,
      completion: completion[p.i],
      turnaround: completion[p.i] - p.arrival,
      waiting: completion[p.i] - p.arrival - p.burst,
      response: firstRun[p.i] - p.arrival
    }));

    const totalTime = time;
    const runTime = procs.reduce((s, p) => s + p.burst, 0);
    const sum = kind => segs.filter(s => s.kind === kind).reduce((s, x) => s + x.end - x.start, 0);
    let switches = 0, last = null;
    for (const s of segs) {
      if (s.kind !== 'run') continue;
      if (last !== null && last !== s.pid) switches++;
      last = s.pid;
    }

    const n = procs.length;
    return {
      segments: segs,
      results: results,
      summary: {
        totalTime: totalTime,
        idleTime: sum('idle'),
        ctxTime: sum('ctx'),
        switches: switches,
        avgWaiting: results.reduce((s, r) => s + r.waiting, 0) / n,
        avgTurnaround: results.reduce((s, r) => s + r.turnaround, 0) / n,
        avgResponse: results.reduce((s, r) => s + r.response, 0) / n,
        utilization: runTime / totalTime,
        throughput: n / totalTime
      }
    };
  }

  // Run every algorithm variant on the same input for the comparison table.
  function compare(input) {
    const defs = [
      { key: 'fcfs', label: 'FCFS' },
      { key: 'sjf', label: 'SJF' },
      { key: 'srtf', label: 'SRTF' },
      { key: 'prio', label: 'Priority', preemptive: false },
      { key: 'prio', label: 'Priority, preemptive', preemptive: true },
      { key: 'rr', label: 'Round robin' }
    ];
    return defs.map(d => {
      const r = simulate({
        processes: input.processes,
        algorithm: d.key,
        quantum: input.quantum,
        ctxSwitch: input.ctxSwitch,
        preemptive: !!d.preemptive
      });
      return { key: d.key, preemptive: !!d.preemptive, label: d.label, summary: r.summary };
    });
  }

  return { simulate: simulate, compare: compare };
});
