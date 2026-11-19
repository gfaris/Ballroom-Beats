/* Ballroom Beat — interface, audio and tap capture. Analysis and scoring live in analysis.js. */
(function () {
  'use strict';

  var BA = window.BeatAnalysis;
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    for (k in attrs || {}) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function clock(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  // ---------- saved state ----------
  var KEY = 'ballroomBeat.v1';
  var S = { cal: 0, songs: [], mode: 'practice', len: 2 };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved) for (var k in saved) S[k] = saved[k]; } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  // ---------- views ----------
  var VIEWS = ['home', 'song', 'play', 'result'];
  function show(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    window.scrollTo(0, 0);
  }

  // ---------- audio ----------
  var ctx = null;
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      // iOS: play through the silent switch, like a music app
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    }
    return ctx;
  }
  function decode(arrayBuffer) {
    var c = audio();
    return new Promise(function (res, rej) {
      var p = c.decodeAudioData(arrayBuffer, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }
  function outputDelay() { return (ctx.outputLatency || 0) + (ctx.baseLatency || 0); }

  // Map a tap's timestamp onto the audio clock. currentTime advances in blocks, so the largest
  // (audio - wall) difference we have seen is the tightest estimate of the true offset.
  var clockOff = -Infinity;
  function sampleClock() { var d = ctx.currentTime - performance.now() / 1000; if (d > clockOff) clockOff = d; }
  function eventAudioTime(ev) {
    sampleClock();
    var now = performance.now(), p = ev && ev.timeStamp;
    if (!(p > 0) || Math.abs(p - now) > 1000) p = now;
    return p / 1000 + clockOff;
  }

  function click(at, accent, bus) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    o.connect(g); g.connect(bus); o.start(at); o.stop(at + 0.06);
  }

  // ---------- analysis worker ----------
  var worker = null, seq = 0;
  function runAnalysis(samples, sr) {
    return new Promise(function (res, rej) {
      function inline() { setTimeout(function () { try { res(BA.analyze(samples, sr)); } catch (e) { rej(e); } }, 30); }
      try {
        if (!worker) worker = new Worker('analysis.js');
        var id = ++seq;
        worker.onmessage = function (ev) {
          if (ev.data.id !== id) return;
          if (ev.data.ok) res(ev.data.result); else rej(new Error(ev.data.error));
        };
        worker.onerror = function () { worker = null; inline(); };
        worker.postMessage({ id: id, samples: samples, sampleRate: sr });
      } catch (e) { worker = null; inline(); }
    });
  }

  // ---------- home: search, starters, recent ----------
  var STARTERS = [
    ['Waltz', [['Moon River', 'moon river andy williams'], ['Tennessee Waltz', 'tennessee waltz patti page']]],
    ['Tango', [['Por una Cabeza', 'por una cabeza the tango project'], ['Santa Maria', 'santa maria gotan project']]],
    ['Foxtrot', [['Fly Me to the Moon', 'fly me to the moon frank sinatra'], ['The Way You Look Tonight', 'the way you look tonight frank sinatra']]],
    ['Cha Cha', [['Sway', 'sway michael buble'], ['Smooth', 'smooth santana']]],
    ['Rumba', [['Kokomo', 'kokomo beach boys'], ['Under the Boardwalk', 'under the boardwalk drifters']]],
    ['Swing', [['In the Mood', 'in the mood glenn miller'], ['Rock Around the Clock', 'rock around the clock bill haley']]]
  ];

  function renderStarters() {
    var box = $('starters'); box.textContent = '';
    STARTERS.forEach(function (row) {
      box.appendChild(h('div', { class: 'starter-row' }, [
        h('span', { class: 'dance', text: row[0] }),
        h('span', { class: 'chips' }, row[1].map(function (s) {
          return h('button', { class: 'chip', type: 'button', text: s[0], onclick: function () { $('q').value = s[0]; search(s[1], s[0]); } });
        }))
      ]));
    });
  }

  function toSong(r) {
    return {
      id: r.trackId, title: r.trackName, artist: r.artistName, url: r.previewUrl, genre: r.primaryGenreName || '',
      art: (r.artworkUrl100 || '').replace('100x100', '200x200'), link: r.trackViewUrl || ''
    };
  }

  function songRow(song, best) {
    return h('li', {}, [h('button', { class: 'song', type: 'button', onclick: function () { openSong(song); } }, [
      song.art ? h('img', { src: song.art, alt: '', loading: 'lazy', onerror: function () { this.style.visibility = 'hidden'; } }) : h('span', { class: 'art' }),
      h('span', { class: 'meta' }, [h('span', { class: 't', text: song.title }), h('span', { class: 'a', text: song.artist + (song.genre ? ' · ' + song.genre : '') })]),
      best !== undefined && best !== null ? h('span', { class: 'best', text: String(best), title: 'Best score' }) : null
    ])]);
  }

  var searchToken = 0;
  function search(term, label) {
    term = (term || '').trim();
    if (!term) return;
    var token = ++searchToken;
    $('searchError').hidden = true;
    $('resultsSection').hidden = false;
    $('resultsLabel').textContent = 'Searching…';
    $('results').textContent = '';
    var url = 'https://itunes.apple.com/search?' + new URLSearchParams({ term: term, media: 'music', entity: 'song', limit: '25' });
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'busy' : 'http');
      return r.json();
    }).then(function (j) {
      if (token !== searchToken) return;
      var songs = (j.results || []).filter(function (r) { return r.previewUrl && r.trackName; }).map(toSong);
      $('resultsLabel').textContent = songs.length ? 'Results for “' + (label || term) + '”' : 'Nothing found for “' + (label || term) + '”';
      songs.forEach(function (s) { $('results').appendChild(songRow(s)); });
    }).catch(function (e) {
      if (token !== searchToken) return;
      $('resultsSection').hidden = true;
      $('searchError').hidden = false;
      $('searchError').textContent = e.message === 'busy'
        ? 'Apple’s song search is asking us to slow down. Wait about a minute and search again.'
        : 'Couldn’t reach the song search. Check your connection and try again.';
    });
  }

  function renderRecent() {
    var list = $('recent'); list.textContent = '';
    $('recentSection').hidden = !S.songs.length;
    S.songs.forEach(function (s) { list.appendChild(songRow(s, s.best)); });
  }

  // ---------- song screen ----------
  var cur = null;         // { song, buffer, offset, dur, analysis, opt, meter }
  var loadToken = 0;

  function fetchPreview(song) {
    return fetch(song.url).then(function (r) { if (!r.ok) throw new Error('preview'); return r.arrayBuffer(); })
      .catch(function () {
        // saved preview links can expire; ask the catalogue for a fresh one
        if (!song.id) throw new Error('preview');
        return fetch('https://itunes.apple.com/lookup?id=' + song.id).then(function (r) { return r.json(); }).then(function (j) {
          var r0 = j.results && j.results[0];
          if (!r0 || !r0.previewUrl) throw new Error('preview');
          song.url = r0.previewUrl;
          return fetch(song.url).then(function (r) { if (!r.ok) throw new Error('preview'); return r.arrayBuffer(); });
        });
      });
  }

  function openSong(song) {
    var token = ++loadToken;
    cur = { song: song, buffer: null, analysis: null, opt: 0, meter: null };
    show('song');
    $('songTitle').textContent = song.title;
    $('songArtist').textContent = song.artist;
    $('songArt').onerror = function () { this.hidden = true; };
    if (song.art) { $('songArt').src = song.art; $('songArt').hidden = false; } else $('songArt').hidden = true;
    $('songLink').hidden = !song.link; if (song.link) $('songLink').href = song.link;
    $('analysis').hidden = true; $('songError').hidden = true;
    $('listening').hidden = false; $('listeningText').textContent = 'Fetching the song…';

    var source = song.file ? song.file.arrayBuffer() : fetchPreview(song);
    source.then(decode).then(function (buf) {
      if (token !== loadToken) return;
      var offset = 0, dur = buf.duration;
      if (dur > 75) { offset = Math.min(45, dur * 0.2); dur = 60; }   // a minute from past the intro
      cur.buffer = buf; cur.offset = offset; cur.dur = dur;
      $('listeningText').textContent = 'Listening for the beat…';
      var sr = buf.sampleRate, a = Math.floor(offset * sr), n = Math.min(buf.length - a, Math.floor(dur * sr));
      var mono = new Float32Array(n), ch = buf.numberOfChannels;
      for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += d[a + i] / ch; }
      return runAnalysis(mono, sr);
    }).then(function (res) {
      if (token !== loadToken || !res) return;
      if (!res.options.length) throw new Error('nobeat');
      cur.analysis = res;
      $('listening').hidden = true; $('analysis').hidden = false;
      renderAnalysis();
    }).catch(function (e) {
      if (token !== loadToken) return;
      $('listening').hidden = true; $('songError').hidden = false;
      $('songError').textContent = e && e.message === 'nobeat'
        ? 'Couldn’t find a steady beat in this one. Try another song.'
        : e && e.message === 'preview' ? 'This song’s preview wouldn’t load. Try another version of it.'
        : 'This audio couldn’t be read. Try another song or file.';
    });
  }

  function option() {
    var o = Object.assign({}, cur.analysis.options[cur.opt]);
    if (cur.meter && cur.meter !== o.meter) { o.meter = cur.meter; o.meterConfidence = 1; o.downbeat = o.downbeat % o.meter; }
    if (cur.downbeat !== undefined && cur.downbeat !== null) o.downbeat = cur.downbeat % o.meter;
    return o;
  }

  var EAR = {
    tango: 'tango is sharp and dramatic, a marching beat with sudden stops',
    chacha: 'cha cha is bright and busy, with a clear “cha-cha-cha” at the end of each bar',
    rumba: 'rumba is slow-burning and romantic, with soft, rolling percussion',
    foxtrot: 'foxtrot is smooth and easy-going, the crooner and big-band sound',
    swing: 'swing is bouncy and upbeat, the kind that makes you want to hop',
    waltz: 'waltz rises and falls gently, ONE-two-three',
    viennese: 'Viennese waltz whirls, a fast ONE-two-three'
  };
  function verdict(f) { return f >= 0.8 ? ['Great fit', 'great'] : f >= 0.55 ? ['Workable', 'ok'] : f >= 0.3 ? ['A stretch', 'ok'] : ['Not this one', 'no']; }

  function renderAnalysis() {
    var res = cur.analysis, o = option();
    $('fBpm').textContent = Math.round(o.bpm);
    $('fMeter').textContent = o.meter + '/4';
    $('fMeterSub').textContent = o.meter === 3 ? 'count 1-2-3' : 'count 1-2-3-4';
    $('fFeel').textContent = o.swing > 0.3 ? 'Swung' : o.swing < -0.3 ? 'Even' : 'Mixed';
    $('fClarity').textContent = res.clarity >= 0.8 ? 'Clear' : res.clarity >= 0.6 ? 'Fair' : 'Faint';

    var tc = $('tempoChips'); tc.textContent = '';
    if (res.options.length > 1) res.options.forEach(function (op, i) {
      tc.appendChild(h('button', { class: 'chip', type: 'button', 'aria-pressed': String(i === cur.opt), text: Math.round(op.bpm) + ' bpm',
        onclick: function () { cur.opt = i; cur.meter = null; cur.downbeat = null; renderAnalysis(); } }));
    });
    var mc = $('meterChips'); mc.textContent = '';
    [3, 4].forEach(function (m) {
      mc.appendChild(h('button', { class: 'chip', type: 'button', 'aria-pressed': String(m === o.meter), text: m + '/4',
        onclick: function () { cur.meter = m; cur.downbeat = null; renderAnalysis(); } }));
    });

    var fits = BA.danceFits(o, cur.song.genre), list = $('fits'); list.textContent = '';
    var shown = fits.filter(function (f) { return f.fit >= 0.3; });
    if (!shown.length) shown = fits.slice(0, 1);
    shown.forEach(function (f) {
      var v = verdict(f.fit), why;
      if (!f.meterOk) why = 'Needs ' + f.meter + '/4 time; this song counts in ' + o.meter + '.';
      else {
        why = 'Ideal is ' + f.range[0] + '–' + f.range[1] + ' bpm' + (f.tempoNote === 'slow' ? '; this is on the slow side' : f.tempoNote === 'fast' ? '; this is on the fast side' : '');
        if (f.feelNote) why += '. The rhythm is ' + (f.feelNote.indexOf('even') === 0 ? 'even rather than swung' : 'swung rather than even');
        if (f.id === 'swing' && f.tempoNote !== 'slow') why += o.bpm >= 160 ? '. Fast: single-step or jive.' : '. Triple-step tempo.';
        else why += '.';
      }
      list.appendChild(h('li', { class: 'fit ' + v[1] }, [
        h('span', { class: 'name', text: f.name }), h('span', { class: 'verdict', text: v[0] }),
        h('span', { class: 'bar' }, [h('i', { style: 'width:' + Math.round(f.fit * 100) + '%' })]),
        h('span', { class: 'why', text: why })
      ]));
    });
    var rest = fits.filter(function (f) { return shown.indexOf(f) < 0; });
    if (rest.length) list.appendChild(h('li', { class: 'note', text: 'Not for ' + rest.map(function (f) { return f.name; }).join(', ') + '.' }));

    // several dances share this tempo: say how to tell them apart by ear
    var top = fits[0].fit, tied = fits.filter(function (f) { return f.fit >= 0.55 && f.fit >= top - 0.1; });
    var ear = $('ear');
    if (tied.length > 1) {
      ear.hidden = false;
      ear.innerHTML = '';
      ear.appendChild(h('b', { text: tied.map(function (f) { return f.name; }).join(', ').replace(/, ([^,]*)$/, ' and $1') }));
      ear.appendChild(document.createTextNode(' all work at this tempo, and the app can only measure tempo and rhythm. Let your ear pick: ' +
        tied.map(function (f) { return EAR[f.id]; }).join('; ') + '.'));
    } else if (top < 0.55) {
      ear.hidden = false; ear.textContent = 'None of the six dances sits comfortably at this tempo. It still works for tap practice.';
    } else ear.hidden = true;

    // one long clip plays once; a 30-second preview can be played twice to make a minute
    var long = cur.dur >= 45;
    $('lenSeg').hidden = long;
    setSeg('modeSeg', 'mode', S.mode); setSeg('lenSeg', 'len', String(S.len));
  }

  function setSeg(id, attr, val) {
    Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset[attr] === val)); });
  }

  // ---------- the tap-along ----------
  var run = null, wake = null;

  function startRun() {
    var c = audio();
    var o = option();
    var resume = c.state === 'running' ? Promise.resolve() : c.resume();
    resume.then(function () {
      clockOff = -Infinity; sampleClock();
      var passes = (cur.dur < 45 && S.len === 2) ? 2 : 1, gap = 1.2;
      var t0 = c.currentTime + 0.7;
      var bus = c.createGain(); bus.connect(c.destination);
      var music = c.createGain(); music.gain.value = S.mode === 'practice' ? 0.85 : 1; music.connect(c.destination);
      run = { t0: t0, passes: [], taps: [], sources: [], bus: bus, mode: S.mode, opt: o, meter: o.meter, downbeat: o.downbeat,
              flat: [], next: 0, lastPass: -1, done: false };
      for (var p = 0; p < passes; p++) {
        var start = p * (cur.dur + gap);
        var src = c.createBufferSource(); src.buffer = cur.buffer; src.connect(music);
        src.start(t0 + start, cur.offset, cur.dur);
        run.sources.push(src);
        var beats = o.beats.filter(function (b) { return b >= 0 && b <= cur.dur; }).map(function (b) { return b + start; });
        run.passes.push({ start: start, end: start + cur.dur, beats: beats });
        beats.forEach(function (b, i) { run.flat.push({ t: b, i: i, pass: p }); });
      }
      run.total = passes * cur.dur + (passes - 1) * gap;

      show('play');
      $('shiftOne').hidden = S.mode !== 'practice';
      $('count').textContent = ''; $('ring').style.setProperty('--glow', 0);
      $('padMsg').className = 'padmsg';
      $('padMsg').textContent = S.mode === 'practice' ? 'Tap anywhere, together with the click' : 'Tap anywhere on every beat';
      $('roundCard').hidden = true;
      try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {}); } catch (e) {}
      requestAnimationFrame(frame);
    });
  }

  function songNow() { sampleClock(); return performance.now() / 1000 + clockOff - run.t0; }

  function frame() {
    if (!run || run.done) return;
    var now = songNow(), heard = now - outputDelay();
    // schedule clicks a little ahead (practice only)
    if (run.mode === 'practice') {
      while (run.next < run.flat.length && run.flat[run.next].t < now + 0.25) {
        var b = run.flat[run.next++];
        if (b.t > now + 0.01) click(run.t0 + b.t, ((b.i - run.downbeat) % run.meter + run.meter) % run.meter === 0, run.bus);
      }
      // beat light and count, timed to what is being heard
      var idx = lastBeatIndex(heard);
      if (idx >= 0) {
        var bb = run.flat[idx], age = heard - bb.t;
        $('ring').style.setProperty('--glow', Math.max(0, 0.75 * Math.exp(-age / 0.13)).toFixed(3));
        var n = ((bb.i - run.downbeat) % run.meter + run.meter) % run.meter + 1;
        if ($('count').textContent !== String(n)) $('count').textContent = n;
      }
    }
    // round card between the two passes
    var passIdx = 0;
    for (var p = 0; p < run.passes.length; p++) if (heard >= run.passes[p].start - 1.2) passIdx = p;
    if (passIdx !== run.lastPass) {
      run.lastPass = passIdx;
      if (passIdx > 0) {
        $('roundCard').textContent = 'Round ' + (passIdx + 1) + '. Find it faster.';
        $('roundCard').hidden = false;
        setTimeout(function () { $('roundCard').hidden = true; }, 1300);
      }
    }
    $('progFill').style.width = Math.max(0, Math.min(100, heard / run.total * 100)) + '%';
    $('remain').textContent = clock(run.total - heard);
    if (heard >= run.total + 0.25) return finishRun();
    requestAnimationFrame(frame);
  }

  function lastBeatIndex(t) {
    var f = run.flat, lo = 0, hi = f.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (f[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  function onTap(ev) {
    if (!run || run.done) return;
    if (ev.cancelable) ev.preventDefault();
    var t = eventAudioTime(ev) - run.t0 - outputDelay() - S.cal;
    run.taps.push(t);
    var ring = $('ring');
    ring.classList.remove('tapped'); void ring.offsetWidth; ring.classList.add('tapped');
    if (run.mode === 'practice') {
      // nearest beat, for instant early / late feedback
      var i = lastBeatIndex(t), best = null;
      [i, i + 1].forEach(function (j) { if (j >= 0 && j < run.flat.length) { var e = t - run.flat[j].t; if (best === null || Math.abs(e) < Math.abs(best)) best = e; } });
      var msg = $('padMsg'), tol = 0.07;
      if (best === null) return;
      if (Math.abs(best) <= tol) { msg.textContent = 'On the beat'; msg.className = 'padmsg on'; ring.style.setProperty('--tap', 'var(--brass)'); }
      else if (best < 0) { msg.textContent = 'Early'; msg.className = 'padmsg early'; ring.style.setProperty('--tap', 'var(--early)'); }
      else { msg.textContent = 'Late'; msg.className = 'padmsg late'; ring.style.setProperty('--tap', 'var(--late)'); }
    } else ring.style.setProperty('--tap', 'var(--ivory)');
  }

  function stopAudio() {
    if (!run) return;
    run.done = true;
    run.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    try { run.bus.disconnect(); } catch (e) {}
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
  }

  function finishRun() {
    var r = run; stopAudio();
    var score = BA.scoreTaps(r.taps, r.passes, r.meter, r.downbeat);
    renderResult(score, r);
    run = null;
  }

  function abortRun() { if (!run) return; stopAudio(); run = null; show('song'); }

  // ---------- result ----------
  function renderResult(sc, r) {
    var song = cur.song, o = r.opt, practice = r.mode === 'practice';
    show('result');
    $('resSong').textContent = song.title;
    $('scoreNum').textContent = sc.score;
    $('scoreWord').textContent = sc.taps < 4 ? 'No taps recorded' : sc.offbeat ? 'Steady, but between the beats'
      : sc.score >= 90 ? 'Right in the pocket' : sc.score >= 75 ? 'You’ve got the beat' : sc.score >= 55 ? 'Getting there'
      : sc.score >= 35 ? 'On it, then off it' : 'The beat got away';
    var kind = { half: ' You tapped every other beat, so you were scored on those.', bar: ' You tapped the 1 of each bar, so you were scored on those.',
                 double: ' You tapped twice per beat, so you were scored in double time.', beat: '' }[sc.kind];
    $('scoreSub').textContent = (practice ? 'Practice, with the click.' : 'Test, no help.') + ' ' + Math.round(o.bpm) + ' bpm in ' + o.meter + '/4.' + kind;

    var pct = sc.scoredBeats ? Math.round(100 * sc.hits / sc.scoredBeats) : 0;
    var m = sc.meanOffsetMs, timing = Math.abs(m) < 15 ? 'Dead on' : Math.round(Math.abs(m)) + ' ms ' + (m < 0 ? 'early' : 'late');
    var locks = sc.lock.map(function (x) { return x === null ? 'never' : x.toFixed(1) + ' s'; });
    var stats = [
      [pct + '%', 'of beats hit (' + sc.hits + ' of ' + sc.scoredBeats + ')'],
      [locks.join(' → '), sc.lock.length > 1 ? 'to find the beat, round 1 → 2' : 'to find the beat'],
      [timing, 'average timing'],
      [Math.round(sc.spreadMs) + ' ms', 'wobble from tap to tap'],
      [sc.streak, 'longest run on the beat'],
      [sc.missed + ' · ' + sc.extras, 'beats skipped · extra taps']
    ];
    var box = $('stats'); box.textContent = '';
    stats.forEach(function (s) { box.appendChild(h('div', { class: 'stat' }, [h('b', { text: String(s[0]) }), h('span', { text: s[1] })])); });

    $('chartBox').innerHTML = chart(sc, r);

    var tips = [];
    if (sc.taps < 4) tips.push('Nothing to score. Tap the screen on each beat while the music plays.');
    else {
      if (sc.offbeat) tips.push('Your rhythm was even, but it landed halfway between the beats. In Practice, wait for the light and tap with it. The pulse to catch is usually in the bass and the kick drum.');
      if (!sc.offbeat && m < -40) tips.push('You tap about ' + Math.round(-m) + ' ms ahead of the beat. That is rushing. Let the beat arrive before you move.');
      if (!sc.offbeat && m > 40) tips.push('You tap about ' + Math.round(m) + ' ms behind the beat. Aim to land on the beat, not to start moving on it.');
      if (Math.abs(m) > 90 && !sc.offbeat) tips.push('An offset this large is often the headphones, not you. Run a Sync check from the home screen.');
      if (sc.spreadMs > 55) tips.push('Your taps wobble around the beat. Count out loud, ' + (o.meter === 3 ? '“one, two, three”' : '“one, two, three, four”') + ', and let the count drive your hand.');
      var l0 = sc.lock[0];
      if (l0 === null && !sc.offbeat) tips.push(practice ? 'You never got four beats in a row. Watch the light and say “tap” with each flash before you start tapping.' : 'You never got four beats in a row. Go back to Practice for this song and tap with the click first.');
      else if (l0 > 6) tips.push('It took ' + l0.toFixed(0) + ' seconds to find the beat. Before tapping, listen for the bass or drum and nod along for a bar.');
      if (sc.lock.length > 1 && sc.lock[0] !== null && sc.lock[1] !== null && sc.lock[1] < sc.lock[0] - 1) tips.push('You found the beat faster the second time (' + sc.lock[1].toFixed(1) + ' s against ' + sc.lock[0].toFixed(1) + ' s). That is the skill improving.');
      if (sc.lost.length) {
        var L = sc.lost[0];
        tips.push('You lost the beat around ' + clock(L.from) + '–' + clock(L.to) + '. That is often where the singer or the melody pulls away from the rhythm. Keep your ear on the bass and drums.');
      }
      if (sc.extras > 0.15 * sc.scoredBeats && sc.kind === 'beat') tips.push(sc.extras + ' extra taps. You may be tapping the tune or the words; the beat is the steady pulse underneath them.');
      if (sc.missed > 0.15 * sc.scoredBeats && !sc.lost.length && !sc.offbeat) tips.push('You skipped ' + sc.missed + ' beats. Keep tapping through the quiet parts; the beat carries on even when the band holds back.');
      if (sc.score >= 90) tips.push(practice ? 'Now try Test: the same song with no click and no light.' : 'Try a song with a fainter beat, or a faster dance.');
      if (cur.analysis.clarity < 0.6) tips.push('This song has a faint beat, so the app’s own beat marks are less certain. Treat the score as approximate.');
    }
    var tl = $('tips'); tl.textContent = '';
    tips.slice(0, 4).forEach(function (t) { tl.appendChild(h('li', { text: t })); });

    $('swapModeBtn').textContent = practice ? 'Test it without the click' : 'Practice with the click';

    if (song.id && sc.taps >= 4) {
      var top = BA.danceFits(o, song.genre)[0];
      var rec = S.songs.filter(function (s) { return s.id === song.id; })[0];
      S.songs = S.songs.filter(function (s) { return s.id !== song.id; });
      var entry = { id: song.id, title: song.title, artist: song.artist, url: song.url, art: song.art, genre: song.genre, link: song.link,
                    best: Math.max(sc.score, rec ? rec.best || 0 : 0), dance: top.name, bpm: Math.round(o.bpm) };
      S.songs.unshift(entry); S.songs = S.songs.slice(0, 12); save();
    }
  }

  function chart(sc, r) {
    var W = 340, H = 150, L = 34, R = 6, T = 10, B = 22;
    var span = sc.goodMs * 2, total = r.total;
    function x(t) { return L + (W - L - R) * Math.max(0, Math.min(1, t / total)); }
    function y(e) { return T + (H - T - B) * (0.5 + Math.max(-1, Math.min(1, e / span)) / 2); }
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Each tap plotted as early or late against the beat">';
    s += '<rect x="' + L + '" y="' + y(-sc.goodMs) + '" width="' + (W - L - R) + '" height="' + (y(sc.goodMs) - y(-sc.goodMs)) + '" fill="var(--floor)"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--brass)" stroke-width="1"/>';
    r.passes.forEach(function (p, i) { if (i > 0) s += '<line x1="' + x(p.start) + '" x2="' + x(p.start) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--rail)" stroke-dasharray="3 3"/>'; });
    sc.series.forEach(function (g) {
      if (g.e === null) { if (g.scored) s += '<line x1="' + x(g.t) + '" x2="' + x(g.t) + '" y1="' + (H - B - 5) + '" y2="' + (H - B) + '" stroke="var(--dim)" stroke-width="1.5"/>'; return; }
      var col = Math.abs(g.e) <= sc.goodMs ? 'var(--brass)' : g.e < 0 ? 'var(--early)' : 'var(--late)';
      s += '<circle cx="' + x(g.t).toFixed(1) + '" cy="' + y(g.e).toFixed(1) + '" r="2.6" fill="' + col + '"' + (g.scored ? '' : ' opacity="0.45"') + '/>';
    });
    s += '<text x="0" y="' + (T + 9) + '">early</text><text x="0" y="' + (H - B - 2) + '">late</text>';
    s += '<text x="0" y="' + (y(0) + 4) + '" fill="var(--brass)">beat</text>';
    [0, total / 2, total].forEach(function (t, i) { s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="' + ['start', 'middle', 'end'][i] + '">' + clock(t) + '</text>'; });
    return s + '</svg><p class="note">Gold dots are on the beat. Ticks along the bottom are beats you skipped.</p>';
  }

  // ---------- sync check ----------
  var sync = null;
  function syncState() {
    $('syncState').textContent = S.cal ? 'Currently adjusting your taps by ' + Math.round(S.cal * 1000) + ' ms.' : 'No adjustment saved yet.';
  }
  function startSync() {
    var c = audio();
    (c.state === 'running' ? Promise.resolve() : c.resume()).then(function () {
      clockOff = -Infinity; sampleClock();
      var t0 = c.currentTime + 1, bus = c.createGain(); bus.connect(c.destination);
      sync = { t0: t0, clicks: [], taps: [], bus: bus };
      for (var i = 0; i < 16; i++) { sync.clicks.push(i * 0.6); click(t0 + i * 0.6, false, bus); }
      $('syncStart').disabled = true; $('syncState').textContent = 'Tap anywhere in the circle, exactly with each click.';
      (function tick() {
        if (!sync) return;
        sampleClock();
        var heard = performance.now() / 1000 + clockOff - sync.t0 - outputDelay();
        var i = Math.floor(heard / 0.6 + 1e-6);
        if (i >= 0 && i < 16) {
          $('syncRing').style.setProperty('--glow', Math.max(0, 0.75 * Math.exp(-(heard - i * 0.6) / 0.13)).toFixed(3));
          $('syncCount').textContent = 16 - i;
        }
        if (heard > 16 * 0.6 + 0.3) return endSync();
        requestAnimationFrame(tick);
      })();
    });
  }
  function endSync() {
    var errs = [];
    sync.taps.forEach(function (t) {
      var i = Math.round(t / 0.6);
      if (i >= 3 && i < 16) errs.push(t - i * 0.6);
    });
    try { sync.bus.disconnect(); } catch (e) {}
    sync = null; $('syncStart').disabled = false; $('syncCount').textContent = ''; $('syncRing').style.setProperty('--glow', 0);
    errs.sort(function (a, b) { return a - b; });
    if (errs.length < 8) { $('syncState').textContent = 'Not enough taps to measure. Try again and tap with every click.'; return; }
    var med = errs[errs.length >> 1], q1 = errs[Math.floor(errs.length * 0.25)], q3 = errs[Math.floor(errs.length * 0.75)];
    if (q3 - q1 > 0.09) { $('syncState').textContent = 'Those taps were too uneven to measure. Try again, as steady as you can.'; return; }
    S.cal = Math.max(-0.08, Math.min(0.4, med)); save();
    $('syncState').textContent = 'Saved. Your taps land ' + Math.round(Math.abs(med) * 1000) + ' ms ' + (med < 0 ? 'before' : 'after') + ' the click on this setup, and scores now allow for that.';
  }

  // ---------- wiring ----------
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); $('q').blur(); search($('q').value); });
  $('file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) openSong({ id: null, title: f.name.replace(/\.[^.]+$/, ''), artist: 'From this device', art: '', genre: '', link: '', file: f });
    e.target.value = '';
  });
  $('backHome').addEventListener('click', function () { loadToken++; renderRecent(); show('home'); });
  $('otherSongBtn').addEventListener('click', function () { renderRecent(); show('home'); });
  $('backSong').addEventListener('click', function () { show('song'); });
  $('modeSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { S.mode = b.dataset.mode; save(); setSeg('modeSeg', 'mode', S.mode); } });
  $('lenSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { S.len = +b.dataset.len; save(); setSeg('lenSeg', 'len', String(S.len)); } });
  $('startBtn').addEventListener('click', startRun);
  $('againBtn').addEventListener('click', startRun);
  $('swapModeBtn').addEventListener('click', function () { S.mode = S.mode === 'practice' ? 'test' : 'practice'; save(); startRun(); });
  $('stopBtn').addEventListener('click', abortRun);
  $('shiftOne').addEventListener('click', function () { if (run) { run.downbeat = (run.downbeat + 1) % run.meter; cur.downbeat = run.downbeat; } });
  $('pad').addEventListener('pointerdown', onTap);
  document.addEventListener('keydown', function (e) {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
      if (run) { e.preventDefault(); onTap(e); }
      else if (sync) { e.preventDefault(); onSyncTap(e); }
    }
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { abortRun(); } });

  function onSyncTap(ev) {
    if (!sync) return;
    if (ev.cancelable) ev.preventDefault();
    sync.taps.push(eventAudioTime(ev) - sync.t0 - outputDelay());
    var ring = $('syncRing'); ring.classList.remove('tapped'); void ring.offsetWidth; ring.classList.add('tapped');
  }
  $('openSync').addEventListener('click', function () { syncState(); $('sync').hidden = false; });
  $('closeSync').addEventListener('click', function () { sync = null; $('syncStart').disabled = false; $('sync').hidden = true; });
  $('syncStart').addEventListener('click', startSync);
  $('syncReset').addEventListener('click', function () { S.cal = 0; save(); syncState(); });
  $('syncPad').addEventListener('pointerdown', onSyncTap);

  renderStarters();
  renderRecent();

  // test hook (used by the automated check; harmless in normal use)
  window.__bb = { state: function () { return { run: run, cur: cur, S: S }; } };
  window.__bbSongNow = function () { return run ? songNow() - outputDelay() - S.cal : 0; };
})();
