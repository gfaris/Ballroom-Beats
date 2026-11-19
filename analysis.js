/*
 * Beat analysis for Ballroom Beat.
 * Runs in a Web Worker in the app and under Node for tests.
 *
 * analyze(samples, sampleRate) -> {
 *   duration, clarity (0..1),
 *   options: [{ bpm, meter (3|4), meterConfidence, beats: [seconds], downbeat (index offset),
 *               swing (-1 straight .. +1 swung), label }]   // options[0] is the best guess
 * }
 */
(function (root) {
  'use strict';

  var WIN = 1024;
  var HOP = 128;
  var DIFF_LAG = 4;          // frames between the two spectra compared for flux
  var MIN_BPM = 52, MAX_BPM = 216;

  // ---------- small DSP helpers ----------

  function downsample(x, sr) {
    var f = Math.max(1, Math.round(sr / 22050));
    if (f === 1) return { x: x, sr: sr };
    var n = Math.floor(x.length / f), y = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0, o = i * f;
      for (var k = 0; k < f; k++) s += x[o + k];
      y[i] = s / f;
    }
    return { x: y, sr: sr / f };
  }

  function makeFFT(n) {
    var levels = Math.log2(n) | 0;
    var cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    var rev = new Uint32Array(n);
    for (i = 0; i < n; i++) {
      var r = 0, v = i;
      for (var b = 0; b < levels; b++) { r = (r << 1) | (v & 1); v >>= 1; }
      rev[i] = r;
    }
    return function (re, im) {
      var i, j, k, size, half, step, tr, ti, a, b2;
      for (i = 0; i < n; i++) {
        j = rev[i];
        if (j > i) { tr = re[i]; re[i] = re[j]; re[j] = tr; tr = im[i]; im[i] = im[j]; im[j] = tr; }
      }
      for (size = 2; size <= n; size <<= 1) {
        half = size >> 1; step = n / size;
        for (i = 0; i < n; i += size) {
          for (j = i, k = 0; j < i + half; j++, k += step) {
            a = j + half;
            tr = re[a] * cos[k] + im[a] * sin[k];
            ti = -re[a] * sin[k] + im[a] * cos[k];
            re[a] = re[j] - tr; im[a] = im[j] - ti;
            re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  function median(arr) {
    var a = Array.prototype.slice.call(arr).sort(function (p, q) { return p - q; });
    if (!a.length) return 0;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ---------- onset envelopes ----------

  function onsetEnvelopes(x, sr) {
    var nFrames = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
    var fft = makeFFT(WIN);
    var hann = new Float32Array(WIN);
    for (var i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));

    // log-spaced bands, 40 Hz .. 10 kHz
    var NB = 40, fLo = 40, fHi = Math.min(10000, sr / 2 * 0.95);
    var edges = new Int32Array(NB + 1);
    for (i = 0; i <= NB; i++) {
      var f = fLo * Math.pow(fHi / fLo, i / NB);
      edges[i] = Math.max(1, Math.round(f * WIN / sr));
    }
    for (i = 1; i <= NB; i++) if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
    var lowBands = 0;
    for (i = 0; i < NB; i++) if (edges[i + 1] * sr / WIN <= 220) lowBands = i + 1;
    lowBands = Math.max(lowBands, 3);

    var spec = new Float32Array(nFrames * NB);
    var re = new Float32Array(WIN), im = new Float32Array(WIN);
    for (var t = 0; t < nFrames; t++) {
      var o = t * HOP;
      for (i = 0; i < WIN; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      for (var b = 0; b < NB; b++) {
        var s = 0;
        for (var k = edges[b]; k < edges[b + 1]; k++) s += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        spec[t * NB + b] = Math.log(1 + 20 * s / (WIN / 4));
      }
    }

    var env = new Float32Array(nFrames), low = new Float32Array(nFrames);
    for (t = DIFF_LAG; t < nFrames; t++) {
      var all = 0, lo = 0;
      for (b = 0; b < NB; b++) {
        // reference: max over neighbouring bands in the earlier frame (suppresses vibrato / slides)
        var p = (t - DIFF_LAG) * NB + b;
        var ref = spec[p];
        if (b > 0 && spec[p - 1] > ref) ref = spec[p - 1];
        if (b < NB - 1 && spec[p + 1] > ref) ref = spec[p + 1];
        var d = spec[t * NB + b] - ref;
        if (d > 0) { all += d; if (b < lowBands) lo += d; }
      }
      env[t] = all; low[t] = lo;
    }

    return {
      env: normalizeEnv(env, sr), low: normalizeEnv(low, sr), spec: spec, nBands: NB,
      fps: sr / HOP, nFrames: nFrames,
      // time (s) of envelope frame t; offset calibrated against synthetic clicks (see test/calibrate)
      timeOf: function (t) { return (t * HOP + WIN / 2) / sr + FRAME_OFFSET; }
    };
  }

  // Calibrated so that a sharp onset at time T peaks at timeOf(frame) == T.
  var FRAME_OFFSET = 0;

  function normalizeEnv(e, sr) {
    var n = e.length, out = new Float32Array(n);
    var half = Math.round(0.5 * sr / HOP); // +-0.5 s local mean
    var acc = 0, cnt = 0, lo = 0, hi = -1;
    for (var t = 0; t < n; t++) {
      var wantHi = Math.min(n - 1, t + half), wantLo = Math.max(0, t - half);
      while (hi < wantHi) { hi++; acc += e[hi]; cnt++; }
      while (lo < wantLo) { acc -= e[lo]; lo++; cnt--; }
      var v = e[t] - acc / cnt;
      out[t] = v > 0 ? v : 0;
    }
    var ss = 0;
    for (t = 0; t < n; t++) ss += out[t] * out[t];
    var sd = Math.sqrt(ss / Math.max(1, n)) || 1;
    for (t = 0; t < n; t++) out[t] /= sd;
    return out;
  }

  // ---------- tempo ----------

  function autocorr(e, maxLag) {
    var n = e.length, mean = 0, i;
    for (i = 0; i < n; i++) mean += e[i];
    mean /= n || 1;
    var z = new Float32Array(n);
    for (i = 0; i < n; i++) z[i] = e[i] - mean;
    maxLag = Math.min(maxLag, n - 1);
    var ac = new Float32Array(maxLag + 1);
    for (var lag = 0; lag <= maxLag; lag++) {
      var s = 0;
      for (i = 0; i + lag < n; i++) s += z[i] * z[i + lag];
      ac[lag] = s / (n - lag);
    }
    var a0 = ac[0] || 1;
    for (lag = 0; lag <= maxLag; lag++) ac[lag] /= a0;
    return ac;
  }

  function acAt(ac, lag) { // linear interpolation
    if (lag < 0 || lag >= ac.length - 1) return 0;
    var i = Math.floor(lag), f = lag - i;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  }

  function acPeakNear(ac, lag, tol) { // max within +-tol (fraction)
    var lo = Math.max(1, Math.floor(lag * (1 - tol))), hi = Math.min(ac.length - 1, Math.ceil(lag * (1 + tol)));
    var best = -1, at = lag;
    for (var i = lo; i <= hi; i++) if (ac[i] > best) { best = ac[i]; at = i; }
    return { v: best, lag: at };
  }

  function combScore(ac, P) {
    // support for period P from its first four multiples
    return acPeakNear(ac, P, 0.02).v + 0.5 * acPeakNear(ac, 2 * P, 0.02).v +
           0.33 * acPeakNear(ac, 3 * P, 0.02).v + 0.33 * acPeakNear(ac, 4 * P, 0.02).v;
  }

  function tempoPrior(bpm) { // broad preference for the range people step to
    var d = Math.log2(bpm / 118);
    return Math.exp(-0.5 * d * d / (0.85 * 0.85));
  }

  function estimatePeriods(ac, fps) {
    var minLag = Math.floor(fps * 60 / MAX_BPM), maxLag = Math.ceil(fps * 60 / MIN_BPM);
    var cands = [];
    for (var lag = minLag; lag <= maxLag; lag++) {
      if (!(ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue; // local ACF peaks only
      var raw = combScore(ac, lag);
      if (raw <= 0) continue;
      // parabolic refinement of the peak position
      var a = ac[lag - 1], b = ac[lag], c = ac[lag + 1], den = a - 2 * b + c;
      var P = lag + (den ? 0.5 * (a - c) / den : 0);
      cands.push({ P: P, raw: raw, score: raw * tempoPrior(60 * fps / P) });
    }
    cands.sort(function (p, q) { return q.score - p.score; });
    return cands;
  }

  // ---------- beat tracking (dynamic programming, after Ellis 2007) ----------

  function trackBeats(env, period, tightness) {
    var n = env.length, i, d;
    // smooth the envelope with a Gaussian ~ period/32 wide
    var sigma = Math.max(1, period / 32), rad = Math.ceil(sigma * 3);
    var g = new Float32Array(2 * rad + 1);
    for (i = -rad; i <= rad; i++) g[i + rad] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    var local = new Float32Array(n), mx = 0;
    for (var t = 0; t < n; t++) {
      var s = 0;
      for (i = -rad; i <= rad; i++) { var u = t + i; if (u >= 0 && u < n) s += env[u] * g[i + rad]; }
      local[t] = s; if (s > mx) mx = s;
    }
    var lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2);
    var pen = new Float32Array(hi + 1);
    for (d = lo; d <= hi; d++) { var lg = Math.log(d / period); pen[d] = -tightness * lg * lg; }

    var cum = new Float32Array(n), back = new Int32Array(n), first = true;
    for (t = 0; t < n; t++) {
      var best = -Infinity, arg = -1;
      for (d = lo; d <= hi; d++) {
        var tau = t - d;
        var v = pen[d] + (tau >= 0 ? cum[tau] : 0);
        if (v > best) { best = v; arg = tau; }
      }
      cum[t] = local[t] + best;
      if (first && local[t] < 0.01 * mx) back[t] = -1;
      else { back[t] = arg; first = false; }
    }
    // last beat: the last strong local maximum of the cumulative score
    var peaks = [];
    for (t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) peaks.push(t);
    if (!peaks.length) return [];
    var med = median(peaks.map(function (p) { return cum[p]; }));
    var last = peaks[peaks.length - 1];
    for (i = peaks.length - 1; i >= 0; i--) if (cum[peaks[i]] > 0.5 * med) { last = peaks[i]; break; }
    var beats = [];
    for (t = last; t >= 0; t = back[t]) beats.push(t);
    beats.reverse();
    return beats;
  }

  // Extend the grid to cover the whole clip using the local spacing at each end.
  function extendBeats(times, duration) {
    if (times.length < 4) return times;
    var out = times.slice();
    var headIBI = median(diffs(out.slice(0, 6))), tailIBI = median(diffs(out.slice(-6)));
    while (out[0] - headIBI > 0.02) out.unshift(out[0] - headIBI);
    while (out[out.length - 1] + tailIBI < duration - 0.02) out.push(out[out.length - 1] + tailIBI);
    return out;
  }

  function diffs(a) { var d = []; for (var i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); return d; }

  // ---------- meter, downbeat, swing ----------

  function envAtTime(e, fps, timeToFrame, t, radius) {
    var c = timeToFrame(t), best = 0;
    for (var i = Math.round(c) - radius; i <= Math.round(c) + radius; i++) if (i >= 0 && i < e.length && e[i] > best) best = e[i];
    return best;
  }

  function meterFromAcf(acAll, acLow, P) {
    function tri(ac) {
      var a2 = acPeakNear(ac, 2 * P, 0.025).v, a3 = acPeakNear(ac, 3 * P, 0.025).v,
          a4 = acPeakNear(ac, 4 * P, 0.025).v, a6 = acPeakNear(ac, 6 * P, 0.025).v;
      return { triple: (a3 + 0.5 * a6) / 1.5, duple: (a2 + a4) / 2 };
    }
    var A = tri(acAll), L = tri(acLow);
    var triple = A.triple + L.triple, duple = A.duple + L.duple;
    return { triple: triple, duple: duple };
  }

  // similarity of the spectrum pattern between beats k apart
  function beatSyncSimilarity(spec, nBands, beatFrames) {
    var nb = beatFrames.length - 1;
    if (nb < 12) return null;
    var feats = [];
    for (var i = 0; i < nb; i++) {
      var a = Math.max(0, beatFrames[i]), b = Math.max(a + 1, beatFrames[i + 1]);
      var v = new Float32Array(nBands);
      for (var t = a; t < b; t++) for (var k = 0; k < nBands; k++) v[k] += spec[t * nBands + k];
      for (k = 0; k < nBands; k++) v[k] /= (b - a);
      feats.push(v);
    }
    // remove the running mean so we compare what changes beat to beat
    var mean = new Float32Array(nBands);
    feats.forEach(function (v) { for (var k = 0; k < nBands; k++) mean[k] += v[k] / nb; });
    feats.forEach(function (v) { for (var k = 0; k < nBands; k++) v[k] -= mean[k]; });
    function sim(lag) {
      var s = 0, c = 0;
      for (var i = 0; i + lag < nb; i++) {
        var x = feats[i], y = feats[i + lag], xy = 0, xx = 0, yy = 0;
        for (var k = 0; k < nBands; k++) { xy += x[k] * y[k]; xx += x[k] * x[k]; yy += y[k] * y[k]; }
        if (xx > 0 && yy > 0) { s += xy / Math.sqrt(xx * yy); c++; }
      }
      return c ? s / c : 0;
    }
    return { s2: sim(2), s3: sim(3), s4: sim(4), s6: sim(6) };
  }

  function pickDownbeat(beatStrength, lowStrength, meter) {
    var best = 0, bestV = -Infinity;
    for (var ph = 0; ph < meter; ph++) {
      var s = 0, c = 0;
      for (var i = ph; i < beatStrength.length; i += meter) { s += lowStrength[i] * 1.5 + beatStrength[i]; c++; }
      var v = c ? s / c : 0;
      if (v > bestV) { bestV = v; best = ph; }
    }
    return best;
  }

  function swingFeel(env, beatFrames) {
    var BINS = 48, hist = new Float32Array(BINS), cnt = new Float32Array(BINS);
    for (var i = 0; i + 1 < beatFrames.length; i++) {
      var a = beatFrames[i], b = beatFrames[i + 1], len = b - a;
      if (len < 4) continue;
      for (var t = Math.max(0, a); t < b && t < env.length; t++) {
        var bin = Math.min(BINS - 1, Math.floor((t - a) / len * BINS));
        hist[bin] += env[t]; cnt[bin]++;
      }
    }
    for (i = 0; i < BINS; i++) hist[i] = cnt[i] ? hist[i] / cnt[i] : 0;
    var floor = median(hist);
    function peak(lo, hi) {
      var m = 0;
      for (var k = Math.round(lo * BINS); k <= Math.round(hi * BINS); k++) if (hist[k] - floor > m) m = hist[k] - floor;
      return m;
    }
    var straight = peak(0.46, 0.54), swung = peak(0.61, 0.71);
    var onBeat = Math.max(peak(0, 0.06), peak(0.94, 0.999));
    var sum = straight + swung;
    return {
      value: sum > 0.02 * (onBeat || 1) ? (swung - straight) / sum : 0,
      amount: onBeat > 0 ? sum / onBeat : 0, // how much is going on between the beats at all
      hist: hist
    };
  }

  // ---------- one interpretation of the song at a given period ----------

  function interpret(E, acAll, acLow, period, duration) {
    var frames = trackBeats(E.env, period, 100);
    if (frames.length < 8) return null;
    var times = frames.map(E.timeOf);
    var ibis = diffs(times), ibi = median(ibis);
    var steadyCount = ibis.filter(function (d) { return Math.abs(d / ibi - 1) < 0.06; }).length;
    // frame-quantised median is coarse; when the grid is even, the end-to-end average is exact
    if (steadyCount / ibis.length > 0.9) ibi = (times[times.length - 1] - times[0]) / (times.length - 1);
    // steadiness of the grid itself: share of intervals within 6% of the median
    var steady = ibis.filter(function (d) { return Math.abs(d / ibi - 1) < 0.06; }).length / ibis.length;
    var P = ibi * E.fps;

    var m = meterFromAcf(acAll, acLow, P);
    var sim = beatSyncSimilarity(E.spec, E.nBands, frames);
    var tripleEv = m.triple, dupleEv = m.duple;
    if (sim) { tripleEv += 1.2 * (sim.s3 + 0.5 * sim.s6) / 1.5; dupleEv += 1.2 * (sim.s2 + sim.s4) / 2; }
    var meter = tripleEv > dupleEv ? 3 : 4;
    var meterConfidence = Math.min(1, Math.abs(tripleEv - dupleEv) / (Math.abs(tripleEv) + Math.abs(dupleEv) + 1e-6) * 2.5);

    var strength = frames.map(function (f) { return peakAround(E.env, f, 3); });
    var lowStrength = frames.map(function (f) { return peakAround(E.low, f, 3); });
    var downbeat = pickDownbeat(strength, lowStrength, meter);

    var sw = swingFeel(E.env, frames);

    // how well the onsets actually sit on this grid (0..1)
    var onGrid = 0, total = 0;
    for (var t = 0; t < E.env.length; t++) total += E.env[t];
    var w = Math.max(2, Math.round(P * 0.08));
    frames.forEach(function (f) {
      for (var k = Math.max(0, f - w); k <= Math.min(E.env.length - 1, f + w); k++) onGrid += E.env[k];
    });

    var full = extendBeats(times, duration);
    var shift = full.indexOf(times[0]); // beats added at the front move the downbeat index
    return {
      bpm: 60 / ibi, meter: meter, meterConfidence: meterConfidence,
      tripleEvidence: tripleEv, dupleEvidence: dupleEv,
      beats: full, downbeat: ((downbeat + shift) % meter + meter) % meter,
      swing: sw.value, betweenBeats: sw.amount,
      steady: steady, onGrid: total ? onGrid / total : 0, period: P
    };
  }

  function peakAround(e, f, r) {
    var m = 0;
    for (var i = Math.max(0, f - r); i <= Math.min(e.length - 1, f + r); i++) if (e[i] > m) m = e[i];
    return m;
  }

  // ---------- public entry ----------

  function analyze(samples, sampleRate) {
    var ds = downsample(samples, sampleRate);
    var x = ds.x, sr = ds.sr, duration = x.length / sr;
    var E = onsetEnvelopes(x, sr);
    var maxLag = Math.ceil(E.fps * 60 / MIN_BPM * 6.2);
    var acAll = autocorr(E.env, maxLag), acLow = autocorr(E.low, maxLag);
    var cands = estimatePeriods(acAll, E.fps);
    if (!cands.length) return { duration: duration, clarity: 0, options: [] };

    var main = interpret(E, acAll, acLow, cands[0].P, duration);
    if (!main) return { duration: duration, clarity: 0, options: [] };
    main.support = cands[0].raw;
    var options = [main];

    // Other ways to feel the same song: half / double time, and for triple feels x3 or /3.
    var factors = [2, 0.5, 3, 1 / 3, 1.5, 2 / 3];
    var alts = [];
    factors.forEach(function (f) {
      var P = main.period * f, bpm = 60 * E.fps / P;
      if (bpm < MIN_BPM || bpm > MAX_BPM) return;
      var pk = acPeakNear(acAll, P, 0.04);
      if (pk.v < 0.05) return;
      var raw = combScore(acAll, pk.lag);
      alts.push({ P: pk.lag, raw: raw, score: raw * tempoPrior(bpm) });
    });
    alts.sort(function (p, q) { return q.score - p.score; });
    alts.slice(0, 3).forEach(function (a) {
      var it = interpret(E, acAll, acLow, a.P, duration);
      if (!it) return;
      it.support = a.raw;
      var dup = options.some(function (o) { return Math.abs(o.bpm / it.bpm - 1) < 0.06; });
      if (!dup) options.push(it);
    });

    // Beat clarity: periodicity strength, grid steadiness and how much of the onset energy sits on the grid.
    var per = Math.max(0, Math.min(1, acPeakNear(acAll, main.period, 0.02).v / 0.35));
    var grid = Math.max(0, Math.min(1, (main.onGrid - 0.16) / 0.3));
    var clarity = Math.max(0, Math.min(1, 0.45 * per + 0.35 * grid + 0.2 * main.steady));

    // Pick the way of counting that a dancer would use: an interpretation that lands in a real
    // dance tempo beats one that is merely the strongest pulse (fast swing is often heard at half speed).
    var top = options[0].support || 1;
    options.forEach(function (o) {
      o.bestFit = danceFits(o)[0].fit;
      o.rank = (0.25 + 0.75 * o.bestFit) * Math.min(1, Math.max(0.35, o.support / top));
    });
    options.sort(function (p, q) { return q.rank - p.rank; });
    options.forEach(function (o) { delete o.period; });
    return { duration: duration, clarity: clarity, options: options.slice(0, 3) };
  }

  // ---------- which dance suits this tempo, meter and feel ----------
  // bpm: [ok low, ideal low, sweet spot, ideal high, ok high]
  var DANCES = [
    { id: 'waltz',    name: 'Waltz',          meter: 3, bpm: [76, 84, 88, 96, 108],     feel: 0 },
    { id: 'viennese', name: 'Viennese Waltz', meter: 3, bpm: [126, 150, 168, 180, 192], feel: 0 },
    { id: 'tango',    name: 'Tango',          meter: 4, bpm: [104, 112, 124, 132, 138], feel: -1 },
    { id: 'foxtrot',  name: 'Foxtrot',        meter: 4, bpm: [100, 112, 120, 136, 144], feel: 1 },
    { id: 'chacha',   name: 'Cha Cha',        meter: 4, bpm: [104, 112, 122, 128, 134], feel: -1 },
    { id: 'rumba',    name: 'Rumba',          meter: 4, bpm: [88, 96, 108, 132, 146],   feel: -1 },
    { id: 'swing',    name: 'Swing',          meter: 4, bpm: [120, 132, 144, 178, 192], feel: 1 }
  ];

  function tempoFit(bpm, r) {
    function lerp(x, x0, x1, y0, y1) { return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    if (bpm < r[0]) return Math.max(0, lerp(bpm, r[0] * 0.92, r[0], 0, 0.4));
    if (bpm < r[1]) return lerp(bpm, r[0], r[1], 0.4, 0.9);
    if (bpm <= r[2]) return lerp(bpm, r[1], r[2], 0.9, 1);
    if (bpm <= r[3]) return lerp(bpm, r[2], r[3], 1, 0.9);
    if (bpm <= r[4]) return lerp(bpm, r[3], r[4], 0.9, 0.4);
    return Math.max(0, lerp(bpm, r[4], r[4] * 1.08, 0.4, 0));
  }

  // GENRE_HINTS: small nudges from the store's genre label, never enough to override tempo or meter.
  var GENRE_HINTS = [
    [/tango/i, { tango: 1.25, chacha: 0.85, rumba: 0.85, foxtrot: 0.85, swing: 0.85 }],
    [/latin|salsa|tropical|bolero|bossa|brazil|cuba/i, { chacha: 1.1, rumba: 1.1, foxtrot: 0.9, swing: 0.9 }],
    [/jazz|swing|big band|vocal|easy listening|standards|traditional pop/i, { foxtrot: 1.1, swing: 1.1 }],
    [/rock & roll|rockabilly|doo wop|oldies/i, { swing: 1.1 }]
  ];

  function danceFits(opt, genre) {
    var conf = Math.max(0, Math.min(1, opt.meterConfidence));
    var hints = {};
    if (genre) GENRE_HINTS.forEach(function (h) { if (h[0].test(genre)) for (var k in h[1]) hints[k] = (hints[k] || 1) * h[1][k]; });
    return DANCES.map(function (d) {
      var tf = tempoFit(opt.bpm, d.bpm);
      var meterOk = d.meter === opt.meter;
      var gate = meterOk ? 1 : 0.5 - 0.4 * conf;        // a wrong meter is nearly disqualifying
      var feel = 1, feelNote = '';
      if (d.feel > 0) { feel = opt.swing > 0.3 ? 1 : opt.swing < -0.3 ? 0.72 : 0.88; }
      if (d.feel < 0) { feel = opt.swing < -0.3 ? 1 : opt.swing > 0.3 ? 0.62 : 0.85; }
      if (d.feel > 0 && opt.swing < -0.3) feelNote = 'even rhythm, not swung';
      if (d.feel < 0 && opt.swing > 0.3) feelNote = 'swung rhythm';
      var fit = Math.min(1, tf * gate * feel * (hints[d.id] || 1));
      var tempoNote = opt.bpm < d.bpm[1] ? 'slow' : opt.bpm > d.bpm[3] ? 'fast' : 'ok';
      return { id: d.id, name: d.name, fit: fit, tempoFit: tf, meterOk: meterOk, tempoNote: tempoNote, feelNote: feelNote, range: [d.bpm[1], d.bpm[3]], meter: d.meter };
    }).sort(function (p, q) { return q.fit - p.fit; });
  }

  // ---------- scoring a tap-along ----------
  // taps: seconds on the song clock. passes: [{ start, end, beats: [seconds] }] (one per play-through).
  function scoreTaps(taps, passes, meter, downbeat) {
    taps = taps.slice().sort(function (a, b) { return a - b; });
    var kinds = [{ kind: 'beat', step: 1, phase: 0 }];
    kinds.push({ kind: 'half', step: 2, phase: 0 }, { kind: 'half', step: 2, phase: 1 });
    if (meter === 3) for (var ph = 0; ph < 3; ph++) kinds.push({ kind: 'bar', step: 3, phase: ph });
    kinds.push({ kind: 'double', step: 0.5, phase: 0 });

    var results = kinds.map(function (k) { return scoreOnGrid(taps, passes, k); });
    var best = results[0];
    for (var i = 1; i < results.length; i++) {
      // only read the taps as half-time / double-time / downbeats when that is clearly what happened
      if (results[i].score > best.score + 12 && results[i].score > results[0].score + 12) best = results[i];
    }
    if (best.kind === 'double') {
      // taps that sit only on the "and" between beats are steady but off the beat, not double time
      var on = best.onBeatHits, off = best.hits - best.onBeatHits;
      if (on < 0.35 * best.hits) { best = results[0]; best.offbeat = off >= 0.5 * best.scoredBeats; }
      else if (off < 0.35 * best.hits) best = results[0];
    }
    best.everyBeatScore = results[0].score;
    return best;
  }

  function scoreOnGrid(taps, passes, k) {
    var grid = []; // { t, pass, scored }
    passes.forEach(function (p, pi) {
      var b = p.beats, pts = [];
      if (k.step >= 1) { for (var i = k.phase; i < b.length; i += k.step) pts.push(b[i]); }
      else { for (i = 0; i < b.length; i++) { pts.push(b[i]); if (i + 1 < b.length) pts.push(-(b[i] + b[i + 1]) / 2); } }
      var ibi = pts.length > 1 ? median(diffs(pts.map(Math.abs))) : 0.5;
      var grace = Math.max(2.0, 4 * ibi);
      pts.forEach(function (v) {
        var t = Math.abs(v); // negative marks an in-between point on the double-time grid
        if (t < p.start || t > p.end) return;
        grid.push({ t: t, mid: v < 0, pass: pi, scored: t >= p.start + grace && t <= p.end - 0.4, tap: null, e: null });
      });
    });
    var n = grid.length;
    var empty = { score: 0, kind: k.kind, onBeatHits: 0, offbeat: false, hits: 0, perfect: 0, missed: 0, extras: 0, scoredBeats: 0, meanOffsetMs: 0, spreadMs: 0,
                  streak: 0, lock: passes.map(function () { return null; }), series: [], goodMs: 100, biasMs: 0, taps: taps.length, lost: [] };
    if (n < 4) return empty;
    var ibiAll = median(diffs(grid.map(function (g) { return g.t; })));
    var good = Math.min(0.10, 0.20 * ibiAll), perfect = good / 2, reach = 2 * good;

    function nearest(t) {
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (grid[mid].t <= t) lo = mid; else hi = mid; }
      return Math.abs(grid[lo].t - t) <= Math.abs(grid[hi].t - t) ? lo : hi;
    }
    // systematic offset (device delay or a habit of anticipating); only part of it is forgiven
    var raw = taps.map(function (t) { return t - grid[nearest(t)].t; });
    var bias = raw.length ? median(raw) : 0;
    var forgiven = Math.max(-0.08, Math.min(0.08, bias));

    var extras = 0;
    taps.forEach(function (t) {
      var tc = t - forgiven, j = nearest(tc), e = tc - grid[j].t, g = grid[j];
      if (Math.abs(e) > reach) { if (g.scored) extras++; return; }
      if (g.tap === null) { g.tap = t; g.e = e; }
      else if (Math.abs(e) < Math.abs(g.e)) { g.tap = t; g.e = e; if (g.scored) extras++; }
      else if (g.scored) extras++;
    });

    var pts = 0, scoredBeats = 0, hits = 0, perf = 0, missed = 0, streak = 0, run = 0, errs = [], rawErrs = [], onBeatHits = 0;
    grid.forEach(function (g) {
      var a = g.e === null ? null : Math.abs(g.e);
      var hit = a !== null && a <= good;
      if (hit) { run++; if (run > streak) streak = run; } else run = 0;
      if (!g.scored) return;
      scoredBeats++;
      if (a === null) { missed++; return; }
      errs.push(g.e); rawErrs.push(g.e + forgiven);
      if (a <= perfect) { pts += 1; perf++; hits++; }
      else { pts += Math.max(0, 1 - (a - perfect) / (reach - perfect)); if (hit) hits++; }
      if (hit && !g.mid) onBeatHits++;
    });
    var mean = rawErrs.length ? rawErrs.reduce(function (x, y) { return x + y; }, 0) / rawErrs.length : 0;
    var cm = errs.length ? errs.reduce(function (x, y) { return x + y; }, 0) / errs.length : 0;
    var sd = errs.length > 1 ? Math.sqrt(errs.reduce(function (x, y) { return x + (y - cm) * (y - cm); }, 0) / (errs.length - 1)) : 0;

    // how long until the beat was found in each pass: first run of four hits in a row
    var lock = passes.map(function (p, pi) {
      var g = grid.filter(function (q) { return q.pass === pi; });
      for (var i = 0; i + 3 < g.length; i++) {
        var ok = true;
        for (var j = i; j < i + 4; j++) if (g[j].e === null || Math.abs(g[j].e) > good) { ok = false; break; }
        if (ok) return g[i].t - p.start;
      }
      return null;
    });
    // stretches where the beat was lost (4+ scored beats in a row without a hit)
    var lost = [], startLost = null, cnt = 0;
    grid.forEach(function (g, i) {
      var hit = g.e !== null && Math.abs(g.e) <= good;
      if (g.scored && !hit) { if (startLost === null) startLost = g.t; cnt++; }
      else { if (cnt >= 4) lost.push({ from: startLost, to: grid[i - 1].t }); startLost = null; cnt = 0; }
    });
    if (cnt >= 4) lost.push({ from: startLost, to: grid[n - 1].t });

    var score = scoredBeats ? 100 * Math.max(0, pts - 0.5 * extras) / scoredBeats : 0;
    return {
      score: Math.round(Math.min(100, score)), kind: k.kind, hits: hits, perfect: perf, missed: missed, extras: extras,
      onBeatHits: onBeatHits, offbeat: false,
      scoredBeats: scoredBeats, meanOffsetMs: mean * 1000, spreadMs: sd * 1000, streak: streak, lock: lock, lost: lost,
      goodMs: good * 1000, biasMs: bias * 1000, taps: taps.length,
      series: grid.map(function (g) { return { t: g.t, e: g.e === null ? null : g.e * 1000, scored: g.scored, pass: g.pass }; })
    };
  }

  var api = { analyze: analyze, scoreTaps: scoreTaps, danceFits: danceFits, DANCES: DANCES, _internals: { onsetEnvelopes: onsetEnvelopes, downsample: downsample } };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BeatAnalysis = api;

  // Worker entry
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = function (ev) {
      try {
        var r = analyze(ev.data.samples, ev.data.sampleRate);
        root.postMessage({ ok: true, id: ev.data.id, result: r });
      } catch (err) {
        root.postMessage({ ok: false, id: ev.data.id, error: String(err && err.message || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
