#!/usr/bin/env node
// ============ TELEGRAM CONTROLLER — kintara farm bot (kamu kontrol via TG) ============
// Commands: /rock /wood /combat /boss /spinner /tutorial /status /stop /help
// 1 akun = 1 aktivitas. Start: TELEGRAM_BOT_TOKEN di .env lalu `node tools/telegram-ctl.js`
const fs = require('fs');
const path = require('path');
const { config, persistEnv } = require('../config');
const { KintaraClient } = require('../lib/kintaraClient');
const tg = require('../lib/telegram');

// ---- PANEL: log gaya stats-box monospace (ala screenshot user) ----
// panel('Txt', [['Ronde','1490501'], ...], '📊') → box <code> label : value </code>
// baris di-align otomatis biar colon lurus. Warna: label putih, value bold.
function panel(title, rows, icon = '') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const w = Math.max(...rows.map((r) => esc(r[0]).length));
  const lines = rows.map(([k, v]) => `${esc(k).padEnd(w)} : <b>${esc(v)}</b>`);
  const head = (icon ? icon + ' ' : '') + `<b>${esc(title)}</b>`;
  return `<code>${head}\n${lines.join('\n')}</code>`;
}
// blok dipisah blank-line (2 section kayak screenshot): panel2(title, sec1, sec2)
function panel2(title, sec1, sec2, icon = '') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mk = (rows) => {
    const w = Math.max(...rows.map((r) => esc(r[0]).length));
    return rows.map(([k, v]) => `${esc(k).padEnd(w)} : <b>${esc(v)}</b>`);
  };
  const head = (icon ? icon + ' ' : '') + `<b>${esc(title)}</b>`;
  return `<code>${head}\n${mk(sec1).join('\n')}\n\n${mk(sec2).join('\n')}</code>`;
}
const loops = require('./farm-loops');
const { levelFromTotalXp, formatSkillBandProgressShort, averageLevelFloor, preciseAverageLevel } = require('../lib/skillXp');
const { isWalletBannedError } = require('../lib/walletAuth');

const OUT = path.join(__dirname, '..', 'recon');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'telegram-ctl.log');
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  try {
    // rotasi harian: 1 file/hari, autohapus file >7 hari
    const today = new Date().toISOString().slice(0, 10);
    const file = LOG.replace(/telegram-ctl\.log$/, `telegram-ctl-${today}.log`);
    fs.appendFileSync(file, s + '\n');
    if (today !== log._day) {
      log._day = today;
      try { // hapus log lama >7 hari
        const cutoff = Date.now() - 7 * 86400000;
        for (const f of fs.readdirSync(OUT)) {
          if (/telegram-ctl-\d{4}-\d{2}-\d{2}\.log$/.test(f)) {
            const st = fs.statSync(path.join(OUT, f));
            if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(OUT, f));
          }
        }
      } catch {}
    }
  } catch {}
  console.error(s); // stderr — biar gak dobel dengan appendFileSync di file
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- state aktivitas ----
let current = null; // { name, stopFlag, startedAt, stats, notif }
function makeCtx(name, opts = {}) {
  const ctx = {
    name, _stop: false, _lastBeat: Date.now(), counters: {}, ...opts,
    stop: () => ctx._stop,
    bump: (k) => { ctx.counters[k] = (ctx.counters[k] || 0) + 1; ctx._lastBeat = Date.now(); },
    get: (k) => ctx.counters[k] || 0,
    onEvent: (msg) => {
      ctx._lastBeat = Date.now(); // heartbeat watchdog: bukti aktivitas masih jalan
      // progress cuma ke file log — progress di chat TIDAK dikirim (cek via /status)
      log(`[${name}] ${msg}`);
    },
    // momen penting → langsung ke chat (bukan spam: cuma dragon kill / level up / SPIN)
    onImportant: (msg) => { tg.send(`⚡ ${msg}`).catch(() => {}); },
  };
  return ctx;
}

// ---- client management ----
let cli = null, player = null, cliAt = 0;
async function getClient() {
  if (cli && Date.now() - cliAt < 30 * 60000) return cli;
  const cfgmod = require('../config');
  const r = await KintaraClient.create(cfgmod.config.walletPrivateKey ? { privateKey: cfgmod.config.walletPrivateKey, forceLogin: true } : { forceLogin: true });
  cli = r.client; player = r.player; cliAt = Date.now();
  return cli;
}

// ---- activity runner ----
// rows counter sesi buat panel — cuma yang > 0 biar ringkas
function sumRows(name, counters) {
  const ICONS = { kill: '⚔️', felled: '🪓', stone: '🪨', coal: '⚫', metal: '🔩', wood: '🪵', cast: '🎣', fish: '🐟', hits: '🗡️', cooked: '🍳' };
  const LABEL = { kill: 'Kill', felled: 'Node tumbang', stone: 'Stone', coal: 'Coal', metal: 'Metal', wood: 'Wood', cast: 'Cast', fish: 'Ikan', hits: 'Hit', cooked: 'Cooked' };
  const rows = [];
  for (const [k, n] of Object.entries(counters || {})) {
    if (n > 0 && LABEL[k]) rows.push([`${ICONS[k]} ${LABEL[k]}`, String(n)]);
  }
  return rows.length ? rows : [['Hasil', '—']];
}


// ================= HUMANIZER (anti-detection) =================
// Micro-break: tiap 90–240 mnt jalan → istirahat acak 8–35 mnt (runner dimatikan bersih, respawn otomatis).
// Tidur panjang: tiap 18–26 jam → tidur 3–6 jam (jam mulai acak). KINTARA_JITTER=0.25 → jeda ±25% (di farm-loops).
const MIN2MS = 60000;
const hrnd = (a, b) => a + Math.random() * (b - a);
const hz = {
  // ENV-configurable (KINTARA_HUMAN profil): break tiap 45–120 mnt, 15–45 mnt; tidur tiap 8–14 jam, 2–5 jam
  breakEvery: () => hrnd(Number(process.env.KINTARA_BREAK_EVERY_MIN_A || 90), Number(process.env.KINTARA_BREAK_EVERY_MIN_B || 240)) * MIN2MS,
  breakDur: () => hrnd(Number(process.env.KINTARA_BREAK_DUR_MIN_A || 8), Number(process.env.KINTARA_BREAK_DUR_MIN_B || 35)) * MIN2MS,
  sleepEvery: () => hrnd(Number(process.env.KINTARA_SLEEP_EVERY_H_A || 18), Number(process.env.KINTARA_SLEEP_EVERY_H_B || 26)) * 60 * MIN2MS,
  sleepDur: () => hrnd(Number(process.env.KINTARA_SLEEP_DUR_MIN_A || 180), Number(process.env.KINTARA_SLEEP_DUR_MIN_B || 360)) * MIN2MS,
};
function humanizerState() {
  // nextBreak/nextSleep = kapan pause berikutnya; pausedUntil = null kalau tidak sedang pause
  return { nextBreak: Date.now() + hz.breakEvery(), nextSleep: Date.now() + hz.sleepEvery(), pausedUntil: null, resumeCmd: null, wasSleep: false };
}
// dipanggil dari loop polling: kalau waktunya break/sleep dan ada aktivitas → stop bersih + tunggu + auto-respawn
function humanizerTick(state) {
  // JANGAN await sleep panjang di sini — polling Telegram harus tetap jalan (bot tetap bisa /status dll).
  const now = Date.now();
  // 1) sedang pause → cek apakah waktunya bangun
  if (state.pausedUntil) {
    if (now < state.pausedUntil) return;
    const resume = state.resumeCmd;
    state.pausedUntil = null;
    try {
      if (resume === 'auto') startAuto();
      else { const c = commands[resume]; if (c) c([]); }
      tg.send(`☀️ Bangun — ${resume} respawn otomatis.`).catch(() => {});
    } catch (e) { log('respawn err: ' + e.message); }
    state.nextBreak = Date.now() + hz.breakEvery();
    if (state.wasSleep) { state.nextSleep = Date.now() + hz.sleepEvery(); state.wasSleep = false; }
    return;
  }
  // 2) belum waktunya pause
  const long = now >= state.nextSleep;
  if (!long && now < state.nextBreak) return;
  // 3) waktunya pause — hanya kalau ada aktivitas jalan
  if (!current && !auto) { state.nextBreak = Date.now() + hz.breakEvery(); return; }
  const name = current ? current.name : 'auto';
  // BUGFIX: kalau yang di-stop sesi AUTO (current.auto), respawn HARUS balik ke startAuto()
  // — bukan commands[name] yang itu sesi MANUAL tanpa batas (dulu rock jalan 23 mnt pasca break).
  state.resumeCmd = (current && current.auto) || !current ? 'auto' : name;
  if (current) current.ctx._stop = true;
  if (auto) auto = null;
  const durMin = long ? hrnd(180, 360) : hrnd(8, 35);
  state.pausedUntil = Date.now() + durMin * MIN2MS;
  state.wasSleep = long;
  log(`😴 ${long ? 'TIDUR PANJANG' : 'micro-break'} ${Math.round(durMin)} mnt — ${name} dimatikan bersih`);
  tg.send(`😴 ${long ? 'TIDUR PANJANG' : 'Micro-break'} — ${name} dimatikan bersih, istirahat ${Math.round(durMin)} mnt. Respawn otomatis.\n<i>(bot tetap bisa /status)</i>`).catch(() => {});
}

async function startActivity(name, fn, opts = {}) {
  if (auto) return `🔄 AUTO mode jalan. Kirim /stop dulu kalau mau manual.`;
  if (current) return `⛔ Sedang jalan: ${current.name}. Kirim /stop dulu.`;
  const ctx = makeCtx(name, opts);
  ctx.manual = true; // MODE MANUAL = TANPA BATAS: death cap, rodless-stop, retreat-exit → semua dimatikan (AUTO tetap pakai guard)
  current = { name, ctx, startedAt: Date.now() };
  (async () => {
    try {
      const c = await getClient();
      const res = await fn(Object.assign(ctx, { cli: c })); // SATU ctx yg sama — jangan salinan, kalau diem _lastBeat gak keliatan watchdog
      const dur = Math.round((Date.now() - current.startedAt) / 60000);
      const sum = fmtSummary(name, res, ctx.counters);
      // spinner: hasil spin (grant) langsung jadi row panel — bukan '—'
      const spinGrant = (name === 'spinner' && res?.spun && res.grant) ? [['🎁 Hadiah', `${res.grant.type || '?'} +${res.grant.n || res.grant.amount || '?'}`]] : [];
      await tg.send(panel(`${activityLabel(name)} — SELESAI`, [
        ['Durasi', `${dur} mnt`],
        ['Hasil', sum],
        ...spinGrant,
        ...sumRows(name, ctx.counters),
      ], '🏁')).catch(() => {});
    } catch (e) {
      if (isWalletBannedError(e)) await tg.send(`⛔ [${name}] wallet kena ban — stop.`).catch(() => {});
      else await tg.send(`⚠️ [${name}] error: ${String(e.message).slice(0, 120)}`).catch(() => {});
      log(`[${name}] FATAL ${e.message}`);
    } finally {
      current = null;
    }
  })();
  return panel(`${activityLabel(name)} — MULAI`, [
    ['Mode', 'Manual — TANPA BATAS'],
    ['Target', 'jalan terus sampai /stop'],
  ], '🚀');
}

function stopActivity() {
  let msg = '';
  if (auto) {
    const cyc = auto.idx;
    auto = null;
    msg += `⏹️ AUTO mode OFF (sudah ${cyc} slot). `;
  }
  if (!current) return msg + (msg ? '' : '🔴 Gak ada aktivitas jalan.');
  current.ctx._stop = true;
  const name = current.name;
  return msg + `⏹️ STOP ${name} — berhenti dalam beberapa detik (selesai node/hit saat ini).`;
}

// ---- AUTO mode: target-based (sesuai request user) ----
// wood ≥1000 → pindah; stone ATAU coal ≥2000 (yg duluan) → pindah;
// combat ≥20 kill → pindah; fish ≥30 cooked → pindah; ulang dari awal.
// /boss JANGAN dimasukkan (butuh lv 20).
const AUTO_ORDER = ['rock', 'wood', 'combat', 'fish'];
const AUTO_TARGET = {
  rock: { label: 'stone/coal 2000', done: (c, r) => (c.stone || 0) >= 2000 || (c.coal || 0) >= 2000, progress: (c) => `🪨 ${c.stone || 0}/2000 ⬛ ${c.coal || 0}/2000` },
  wood: { label: 'wood 1000', done: (c, r) => (c.wood || 0) >= 1000, progress: (c) => `🪵 ${c.wood || 0}/1000` },
  combat: { label: 'kill 20 zombie', done: (c, r) => (c.kill || 0) >= 20, progress: (c) => `☠️ ${c.kill || 0}/20` },
  fish: { label: 'cooked 30', done: (c, r) => (r && r.cooked >= 30) || (c.cooked || 0) >= 30, progress: (c) => `🍳 ${c.cooked || 0}/30` },
};
const AUTO_FNS = {
  rock: (ctx) => loops.runRock(ctx),
  wood: (ctx) => loops.runWood(ctx),
  combat: (ctx) => loops.runCombat(ctx, { dragon: false }),
  fish: (ctx) => loops.runFish(ctx),
};
const AUTO_CHECK_MS = 30 * 1000; // cek target tiap 30 dtk
let auto = null; // { idx, cur, curWhy }

// claim quest yg sudah selesai (ala daily-quest.js repo). return daftar yg di-claim.
async function claimReadyQuests(cli, onMsg) {
  const done = [];
  try {
    const q = await cli.dailyQuestProgress();
    const quests = q?.dailyQuestConfig?.quests || [];
    const prog = q?.dailyQuest?.prog || {};
    const claimed = q?.dailyQuest?.claimed || {};
    for (const x of quests) {
      const pr = prog[x.id] || 0;
      if (pr >= x.target && !claimed[x.id]) {
        try { await cli.dailyQuestClaim(x.id); done.push(x.kind); }
        catch (e) { log(`[auto] claim ${x.kind} gagal: ${String(e.message).slice(0, 60)}`); }
      }
    }
  } catch (e) { log(`[auto] baca quest gagal: ${String(e.message).slice(0, 60)}`); }
  if (done.length && onMsg) onMsg(`🎁 auto-claim quest: ${done.join(', ')}`);
  return done;
}

// pilih slot berikutnya: DIHAPUS — AUTO sekarang target-based (lihat AUTO_TARGET).

function startAuto() {
  if (auto) return `🔄 AUTO sudah jalan (${auto.cur || '?'}). /stop buat berhenti.`;
  if (current) return `⛔ Sedang jalan: ${current.name}. Kirim /stop dulu, baru /auto.`;
  auto = { idx: 0, cur: null, curWhy: '' };
  (async () => {
    while (auto) {
      const name = AUTO_ORDER[auto.idx % AUTO_ORDER.length]; // rock → wood → combat → fish → ulang
      auto.cur = name;
      const tgt = AUTO_TARGET[name];
      const ctx = makeCtx(name);
      current = { name, ctx, startedAt: Date.now(), auto: true };
      log(`[auto fase ${auto.idx + 1}] ${name} mulai — target ${tgt.label}`);
      // patrol: cek target tiap 30 dtk, kalo tercapai → stop fase ini.
      // MAX SESI 10 MNT (KINTARA_PHASE_MAX_MIN) — tiap fase auto-ganti, gaya manusia gak farming nonstop.
      // juga timer max fase → biar AUTO gak nyangkut di fase macet
      const phaseStart = Date.now();
      const PHASE_MAX_MS = Number(process.env.KINTARA_PHASE_MAX_MIN || 10) * 60000;
      const timer = setInterval(() => {
        try {
          if (tgt.done(ctx.counters)) ctx._stop = true;
          if (Date.now() - phaseStart > PHASE_MAX_MS) {
            log(`[auto] fase ${name} lewat ${Math.round(PHASE_MAX_MS / 60000)} mnt tanpa target — skip`);
            ctx._stop = true;
          }
        } catch {}
      }, AUTO_CHECK_MS);
      let res;
      try {
        const c = await getClient();
        res = await AUTO_FNS[name](Object.assign(ctx, { cli: c })); // ctx asli, bukan salinan (heartbeat watchdog)
        // fase gagal krn kekurangan bahan (no-potions/no-wild) → skip & lanjut fase berikutnya
        if (res && (res.err === 'no-potions' || res.err === 'no-wild')) {
          if (auto) await tg.send(`⏭️ ${activityLabel(name)} dilewati (${res.err}) — lanjut fase berikutnya`).catch(() => {});
        }
        const mins = Math.round((Date.now() - current.startedAt) / 60000);
        const sum = fmtSummary(name, res, ctx.counters);
        const done = tgt.done(ctx.counters, res);
        // akhir fase: auto-claim quest + spin
        let extra = '';
        try {
          const claimed = await claimReadyQuests(c, (m) => { extra += ' ' + m; });
          if (claimed.length) log(`[auto] claimed: ${claimed.join(',')}`);
        } catch {}
        try {
          const sp = await c.dailySpinnerSpin();
          if (sp && !/level|locked/.test(JSON.stringify(sp).slice(0, 200))) {
            const grant = sp.grant || sp.reward || sp.prize || {};
            const icon = { gold: '🪙', wood: '🪵', stone: '🪨', coal: '⚫', metal: '🔩', fish: '🐟' }[grant.type] || '🎁';
            extra += ` 🎡 SPIN: ${icon} +${grant.n || grant.amount || '?'} ${grant.type || ''}${sp.crit ? ' (CRIT!)' : ''}`;
            log(`[auto] spin: ${JSON.stringify(sp).slice(0, 80)}`);
          }
        } catch (e) { log(`[auto] spin skip: ${String(e.message).slice(0, 50)}`); }
        if (auto) {
          const nextName = AUTO_ORDER[(auto.idx + 1) % AUTO_ORDER.length];
          const spinRows = [];
          if (extra.includes('SPIN')) { const m = extra.match(/SPIN: (\S+) \+(\S+) (\S+)/); if (m) spinRows.push([`🎡 SPIN`, `${m[1]} +${m[2]} ${m[3]}`]); }
          const claimedM = extra.match(/auto-claim quest: ([\w, ]+)/);
          await tg.send(panel2(`${activityLabel(name)} — FASE #${auto.idx + 1} ${done ? 'TARGET ✅' : 'SELESAI'}`, [
            ['Status', done ? 'Target tercapai' : 'Selesai (skip/max)'],
            ['Durasi', `${mins} mnt`],
            ...sumRows(name, ctx.counters),
            ...(claimedM ? [['🎁 Quest claim', claimedM[1]]] : []),
          ], [
            ['➡️ Next', activityLabel(nextName)],
            ['🎯 Target', AUTO_TARGET[nextName].label],
            ...spinRows,
          ], done ? '✅' : '⏹️')).catch(() => {});
        }
      } catch (e) {
        if (isWalletBannedError(e)) { await tg.send('⛔ wallet kena ban — AUTO OFF.').catch(() => {}); auto = null; current = null; break; }
        log(`[auto] ${name} FATAL ${e.message}`);
        if (auto) await tg.send(`⚠️ ${activityLabel(name)} error: ${String(e.message).slice(0, 100)} — lanjut fase berikutnya`).catch(() => {});
      } finally {
        clearInterval(timer);
        current = null;
        if (auto) auto.idx++;
      }
      if (!auto) break;
      await sleep(5000 + Math.floor(Math.random() * 15000)); // jeda antar fase — acak 5–20 dtk (mode manusia, gak mekanis)
    }
    log('[auto] loop keluar');
  })();
  return panel('AUTO MODE — ON (mode manusia)', [
    ['Fase 1', '🪓 Wood — 1000'],
    ['Fase 2', '⛏ Stone/coal — 2000 (yg duluan)'],
    ['Fase 3', '⚔️ Zombie — 20 kill'],
    ['Fase 4', '🎣 Cooked fish — 30'],
    ['Loop', 'ulang dari Fase 1'],
    ['Cek target', 'tiap 30 dtk'],
    ['Max sesi', `${process.env.KINTARA_PHASE_MAX_MIN || 10} mnt/fase`],
  ], '🔄');
}

// ---- status helpers ----
// ---- status ala repo: header + active + auto mode + session per aktivitas ----
function fmtAgeMin(min) {
  if (min == null) return '?';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}j ${min % 60}m`;
}

function activityLabel(name) {
  return { rock: '⛏ Mining', stone: '🪨 Mining stone', coal: '⬛ Mining coal', wood: '🪓 Wood', combat: '⚔️ Combat (zombie)', boss: '⚔️ Combat (dragon)', fish: '🎣 Fishing', cook: '🍳 Cooking', spinner: '🎡 Spinner', tutorial: '📖 Tutorial' }[name] || name;
}

// ringkasan hasil aktivitas — dipakai pesan "selesai" (manual & auto)
function fmtSummary(name, res, ct) {
  const r = res || {};
  const c = ct || {};
  if (name === 'rock') return `+${r.stone || 0} 🪨 +${r.coal || 0} ⬛ +${r.metal || 0} 🔩 • ${c.felled || 0} node`;
  if (name === 'stone') return `+${r.stone || 0} 🪨 +${r.metal || 0} 🔩 • ${c.felled || 0} node (mode stone)`;
  if (name === 'coal') return `+${r.coal || 0} ⬛ +${r.metal || 0} 🔩 • ${c.felled || 0} node (mode coal)`;
  if (name === 'cook') return `🍳 ${r.cooked || 0} ikan masak${r.err === 'no_fish' ? ' (gak ada ikan mentah)' : ''}`;
  if (name === 'wood') return `+${r.wood || 0} 🪵 • ${c.felled || 0} node`;
  if (name === 'combat' || name === 'boss') { const why = { 'no-sword': '🛑 tanpa pedang', 'sword-lost': '🛑 pedang ilang pas mati', 'death-cap': '🛑 cap 2 mati', 'no-potions': '🛑 potion habis', 'no-wild': '🛑 gagal masuk wild' }[r.err]; return `${r.kills ?? c.kill ?? 0} ☠️${r.deaths ? ` • ${r.deaths} 💀` : ''}${r.retreats ? ` • ${r.retreats} 🏃` : ''}${why ? ` — ${why}` : ''}`; }
  if (name === 'fish') return `${r.ok ?? c.fish ?? 0} 🐟 / ${r.casts ?? c.cast ?? 0} cast`;
  if (name === 'spinner') return r.spun ? `🎡 spin OK${r.grant ? ` — ${r.grant.type || '?'} +${r.grant.n || r.grant.amount || '?'}` : ''}` : `spin gagal: ${r.err || '?'}`;
  if (name === 'tutorial') return r.already ? '✅ Tutorial sudah selesai (akun udah tamat)' : r.step === -1 || r.step >= 28 ? `🎉 Selesai sampai step 28! (${r.okCount || 0} step dijalanin)` : `⏸ Berhenti di step ${(r.step || 0) + 1}/28`;
  const keys = Object.keys(r).filter((k) => typeof r[k] === 'number');
  return keys.length ? keys.map((k) => `${k} ${r[k]}`).join(' • ') : 'selesai';
}

function sessionLine(name, ct, mins) {
  const age = fmtAgeMin(mins);
  if (name === 'rock') return `⛏ felled ${ct.felled || 0} | 🪨 +${ct.stone || 0} | ⬛ +${ct.coal || 0} | 🔩 +${ct.metal || 0} | ⏱ ${age}`;
  if (name === 'stone') return `🪨 stone mode | felled ${ct.felled || 0} | 🪨 +${ct.stone || 0} | ⏱ ${age}`;
  if (name === 'coal') return `⬛ coal mode | felled ${ct.felled || 0} | ⬛ +${ct.coal || 0} | ⏱ ${age}`;
  if (name === 'cook') return `🍳 cooked ${ct.cooked || 0} | ⏱ ${age}`;
  if (name === 'wood') return `🪓 felled ${ct.felled || 0} | 🪵 +${ct.wood || 0} | ⏱ ${age}`;
  if (name === 'combat' || name === 'boss') return `⚔️ kill ${ct.kill || 0} | 🗡️ hits ${ct.hits || 0} | ⏱ ${age}`;
  if (name === 'fish') return `🎣 ${ct.fish || 0}/${ct.cast || 0} | ⏱ ${age}`;
  return null;
}

// ---- MULTI: client per-wallet (login pk tertentu, cache 30 mnt) ----
const _multiClients = new Map(); // idx -> {cli, player, at}
async function getClientForIdx(idx) {
  const hit = _multiClients.get(idx);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit;
  const { loadPks } = require('../lib/parseWallets');
  const pks = loadPks();
  const pk = pks[idx];
  if (!pk) throw new Error('wallet idx ' + idx + ' gak ada');
  const r = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  _multiClients.set(idx, { cli: r.client, player: r.player, at: Date.now() });
  return _multiClients.get(idx);
}
async function walletCount() {
  try { return require('../lib/parseWallets').loadPks().length; } catch { return 1; }
}

async function hStatus() {
  const nW = await walletCount();
  if (nW > 1) {
    // MULTI: status per akun (semua wallet)
    const parts = [];
    for (let i = 0; i < nW; i++) {
      try {
        const { cli, player } = await getClientForIdx(i);
        const me = await cli.me();
        const bp = me.backpack || {};
        const nm = player?.displayName || player?.display_name || player?.name || ('w' + (i + 1));
        parts.push(panel2(`AKUN ${i + 1}: ${nm}`, [
          ['🪨 Stone', String(bp.stone || 0)],
          ['⚫ Coal', String(bp.coal || 0)],
          ['🪵 Wood', String(bp.wood || 0)],
          ['🔩 Metal', String(bp.metal || 0)],
          ['🐟 Fish', String(bp.fish || 0)],
          ['🍳 Cooked', String(bp.cooked_fish_meat || 0)],
          ['🪙 Gold', String(bp.gold || 0)],
          ['🎒 Slots', `${String((bp.invSlots || []).filter(Boolean).length)}/24`],
        ], [['Status', '⛏️ farming (screen kintara-farm)']], '🤖'));
      } catch (e) { parts.push(`⚠️ Akun ${i + 1}: ${String(e.message).slice(0, 60)}`); }
    }
    const head = `🤖 KINTARA STATUS — ${nW} akun\n🎯 Mode: ${process.env.KINTARA_MULTI_MODE || 'auto'} (screen kintara-farm)\n`;
    return head + '\n\n' + parts.join('\n\n');
  }
  const c = await getClient();
  const me = await c.me();
  const bp = me.backpack || {};
  const act = current ? activityLabel(current.name) : 'idle';
  const age = current ? fmtAgeMin(Math.round((Date.now() - current.startedAt) / 60000)) : '—';
  const ses = current ? sumRows(current.name, current.ctx.counters || {}) : [['Status', 'no active session']];
  return panel2('KINTARA BOT STATUS', [
    ['🎯 Active', current ? act : 'idle'],
    ['⏱️ Durasi', current ? age : '—'],
    ['🧠 Auto', auto ? '🟢 ON' : '🔴 OFF'],
    ...ses.map(([k, v]) => [`📈 ${k}`, v]),
  ], [
    ['🪨 Stone', String(bp.stone || 0)],
    ['⚫ Coal', String(bp.coal || 0)],
    ['🪵 Wood', String(bp.wood || 0)],
    ['🔩 Metal', String(bp.metal || 0)],
    ['🐟 Fish', String(bp.fish || 0)],
    ['🍳 Cooked', String(bp.cooked_fish_meat || 0)],
    ['🪙 Gold', String(bp.gold || 0)],
    ['🎒 Slots', `${String((bp.invSlots || []).filter(Boolean).length)}/24`],
  ], '🤖');
}

function fmtSpinnerReady(lastMs) {
  const COOLDOWN = 12 * 3600 * 1000;
  const next = (Number(lastMs) || 0) + COOLDOWN;
  const left = next - Date.now();
  if (left <= 0) return '🎡 Spinner: ✅ FREE SPIN READY — ketik /spinner';
  const h = Math.floor(left / 3600000);
  const m = Math.round((left % 3600000) / 60000);
  return `🎡 Spinner: ⏳ ready dalam ${h}j ${m}m`;
}

async function hSkillsOne(c, pid) {
  const st = await c.playerStats(pid || (await c.me()).player?.id).catch(() => ({}));
  const xp = st.skillXp || {};
  let spinLine;
  try { const me = await c.me(); spinLine = fmtSpinnerReady(me?.meta?.dailySpinnerLastMs); }
  catch { spinLine = '🎡 Spinner: status ?'; }
  const avg = Number.isFinite(Number(st.avg)) ? Number(st.avg) : averageLevelFloor(xp);
  const avgPrecise = preciseAverageLevel(xp).toFixed(2);
  const unlock = avg >= 5 ? '✅ spinner unlocked' : `🔒 spinner butuh avg 5 (skrg ${avg})`;
  const line = (icon, key, label) => {
    const val = xp[key] || 0;
    return `${icon} ${label}: lvl ${levelFromTotalXp(val)} • ${formatSkillBandProgressShort(val)}`;
  };
  return `📊 <b>Stats</b> (avg lvl ${avg} • precise ${avgPrecise})\n` +
    `${line('⚔️', 'combat', 'combat')}\n` +
    `${line('🪓', 'woodcutting', 'woodcutting')}\n` +
    `${line('⛏', 'mining', 'mining')}\n` +
    `${line('🎣', 'fishing', 'fishing')}\n` +
    `${line('🍳', 'cooking', 'cooking')}\n` +
    `${line('🔨', 'smithing', 'smithing')}\n` +
    `${spinLine}\n${unlock}`;
}

async function hSkills() {
  const nW = await walletCount();
  if (nW > 1) {
    const parts = [];
    for (let i = 0; i < nW; i++) {
      try {
        const { cli, player } = await getClientForIdx(i);
        const nm = player?.displayName || player?.display_name || player?.name || ('w' + (i + 1));
        const body = await hSkillsOne(cli, player?.id);
        parts.push(`━━ 🎮 <b>AKUN ${i + 1}: ${nm}</b> ━━\n${body}`);
      } catch (e) { parts.push(`⚠️ Akun ${i + 1}: ${String(e.message).slice(0, 60)}`); }
    }
    return parts.join('\n\n');
  }
  const c = await getClient();
  return hSkillsOne(c, player?.id);
}

async function hQuest() {
  const c = await getClient();
  const q = await c.dailyQuestProgress();
  const quests = q?.dailyQuestConfig?.quests || [];
  const prog = q?.dailyQuest?.prog || {};
  const claimed = q?.dailyQuest?.claimed || {};
  const qIcon = { wood: '🪓', mine: '⛏', stone: '🪨', coal: '⚫', fish: '🎣', kill: '⚔️', combat: '⚔️' };
  const rows = quests.map((x) => {
    const pr = prog[x.id] || 0;
    if (pr >= x.target) return [`${qIcon[x.kind] || '📋'} ${x.kind}`, claimed[x.id] ? '✅ claimed' : '🎁 READY-claim'];
    const pct = Math.min(100, Math.round((pr / Math.max(1, x.target)) * 100));
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return [`${qIcon[x.kind] || '📋'} ${x.kind}`, `${bar} ${pr}/${x.target} (${pct}%)`];
  });
  return panel('DAILY QUEST — PROGRESS', rows, '📋');
}

// ---- handler tambahan (adopsi repo rygroup — REST teruji live) ----
const MARKET_ITEMS = [['wood', '🪵 Wood'], ['stone', '🪨 Stone'], ['coal', '⚫ Coal'], ['metal', '🔩 Metal'], ['fish', '🐟 Fish'], ['cooked_fish_meat', '🍖 Cooked fish']];


async function hMarket() {
  const c = await getClient();
  const lines = ['🛍 <b>Marketplace — Live Prices</b>', ''];
  for (const [t, label] of MARKET_ITEMS) {
    try {
      const r = await c.marketplaceStats(t);
      const floor = r?.floorGold != null ? r.floorGold : (r?.floorToken != null ? r.floorToken + ' $KINS' : null);
      const last = r?.lastSaleGold?.unit != null ? r.lastSaleGold.unit + 'g (x' + r.lastSaleGold.quantity + ')' : '?';
      lines.push(`${label} — floor <b>${floor ?? '?'}</b> | last ${last} | listing ${r?.listings ?? '?'} | stok ${r?.available ?? '?'}`);
    } catch (e) { lines.push(`${label} — err ${String(e.message).slice(0, 30)}`); }
  }
  let kins = '?';
  try { const t = await c.tokenBlimpStats(); kins = '$' + Number(t.priceUsd).toFixed(6); } catch {}
  lines.push('', `🪙 $KINS: <b>${kins}</b>`, '', '<i>Jual via /market tetap versi berikutnya (sell flow). Ini dulu info harga live.</i>');
  return lines.join('\n');
}

async function hServer() {
  const c = await getClient();
  const r = await c.servers().catch((e) => { throw e; });
  const list = (r.servers || []).filter((x) => x && x.id != null);
  if (!list.length) return '⚠️ No server data.';
  list.sort((a, b) => (Number(a.queueLength || 0)) - (Number(b.queueLength || 0)));
  const lines = ['🌐 <b>Servers — Live Queue</b>', ''];
  for (const sv of list) {
    const id = String(sv.controllerId || ('s' + sv.id)).replace(/^s+/, 's'); // anti dobel "ss3"
    const locked = !!sv.requiresMembership;
    const mark = locked ? '🔒' : (sv.full ? '🔴' : '🟢');
    const tag = locked ? ' (membership)' : (sv.full ? ' (full)' : '');
    lines.push(`${mark} ${id} ${sv.name || ''} — queue <b>${sv.queueLength ?? '?'}</b>${tag}`);
  }
  lines.push('', '<i>🔒 butuh membership — auto-skip. Bot auto-pilih queue terkecil.</i>');
  return lines.join('\n');
}

async function hVersion() {
  const c = await getClient();
  const v = await c.version().catch(() => ({}));
  return `🧩 Game version: <code>${String(v?.sha || '?').slice(0, 8)}</code> ${v?.ok ? '✅' : ''}`;
}

// ── KATEGORI ITEM (urutan sesuai prioritas ekonomi) ─────────────
const BAL_CATS = [
  ['⛏ Mining', ['stone', 'coal', 'metal']],
  ['🪓 Woodcut', ['wood']],
  ['🎣 Fishing', ['fish', 'cooked_fish_meat']],
  ['🧪 Potion & Bank', ['potion_health', 'potion_shield', 'bankPages', 'feather', 'leather', 'raw_meat']],
];
const BAL_EMOJI = { stone: '🪨', coal: '⬛', metal: '🔩', wood: '🪵', fish: '🐟', cooked_fish_meat: '🍖', potion_health: '❤️', potion_shield: '🛡', bankPages: '🏦', feather: '🪶', leather: '🟤', raw_meat: '🥩' };
const KNOWN_BAL = new Set(BAL_CATS.flatMap(([, ks]) => ks));

async function hBalance() {
  const c = await getClient();
  const me = await c.me();
  const bp = me.backpack || {};
  const items = Object.keys(bp).filter((k) => typeof bp[k] === 'number' && bp[k] > 0 && !['gold', 'invSlots', 'bankSlots', 'equippedHotbar'].includes(k));
  let kins = '?';
  try { const t = await c.tokenBlimpStats(); kins = `$${Number(t.priceUsd).toFixed(6)} (${t.marketCapLabel || ''})`; } catch {}
  // harga market utk estimasi nilai stok
  const floors = {};
  await Promise.all(MARKET_ITEMS.map(async ([t]) => {
    try { const r = await c.marketplaceStats(t); if (r?.floorGold != null) floors[t] = Number(r.floorGold); } catch {}
  }));
  let estGold = 0; const priced = [];
  for (const k of items) {
    const n = bp[k];
    if (floors[k] != null) { estGold += n * floors[k]; priced.push(k); }
  }
  const L = ['💰 <b>Balance</b>', '', `🪙 <b>gold:</b> ${bp.gold || 0}`, `💎 <b>$KINS:</b> ${kins}`, ''];
  for (const [cat, keys] of BAL_CATS) {
    const rows = keys.filter((k) => items.includes(k));
    if (!rows.length) continue;
    L.push(cat);
    for (const k of rows) {
      const e = BAL_EMOJI[k] || '📦';
      const v = floors[k] != null ? ` — ${(bp[k] * floors[k]).toLocaleString('en-US')}g` : '';
      L.push(`  ${e} ${k.replace(/_/g, ' ')}: <b>${bp[k]}</b>${v}`);
    }
    L.push('');
  }
  const etc = items.filter((k) => !KNOWN_BAL.has(k));
  if (etc.length) { L.push('📦 Others'); for (const k of etc) L.push(`  ${BAL_EMOJI[k] || '▫️'} ${k.replace(/_/g, ' ')}: <b>${bp[k]}</b>`); L.push(''); }
  if (priced.length) {
    L.push('📊 <b>Estimasi nilai stok</b> (harga floor market):');
    L.push(`  💰 <b>~${estGold.toLocaleString('en-US')} gold</b> (${priced.length} item terharga)`);
  }
  return L.join('\n');
}

async function hDiag() {
  const c = await getClient();
  const me = await c.me().catch(() => ({}));
  const st = await c.playerStats(player?.id || me?.player?.id).catch(() => ({}));
  const srv = await c.resolveServer().catch(() => null);
  return `🔧 <b>Diag</b>\n👤 ${player?.displayName || '?'} (id ${player?.id || '?'})\n🧭 shard: ${srv ? srv.shardId + ' @ ' + srv.wsBaseUrl : '?'}\n📈 avg lvl: ${st?.avg ?? '?'}\n🎒 inv ${(me?.backpack?.invSlots || []).filter(Boolean).length}/24 | gold ${me?.backpack?.gold || 0}\n🌐 api: ${c.apiBase}`;
}

// ---- OUTFIT: /outfit (random baru) | /outfit now (lihat sekarang) ----
const OUTFIT_MAX = { hat: 6, top: 8, pants: 6, shoe: 5 };
const OUTFIT_ICON = { hat: '🎩', top: '👕', pants: '👖', shoe: '👟', skinTone: '🧑' };
function outfitShort(o) {
  if (!o || o.hat == null) return '(belum ada — char polos)';
  const g = (k) => `${OUTFIT_ICON[k] || '▫️'} ${k}: ${o[k] ?? '-'}${typeof o[k + 'C'] === 'number' ? ' (warna #' + (o[k + 'C']).toString(16).padStart(6, '0') + ')' : ''}`;
  return [g('hat'), g('top'), g('pants'), g('shoe'), g('skinTone')].join('\n');
}
async function hOutfit(args) {
  const sub = String(args[0] || '').toLowerCase();
  try {
    const c = await getClient();
    if (sub === 'now' || sub === 'cek' || sub === 'lihat') {
      const me = await c.me();
      return `🎽 <b>Outfit saat ini</b>\n<code>${outfitShort(me.outfit)}</code>`;
    }
    const rnd = (n) => Math.floor(Math.random() * n);
    const hex = () => rnd(0xffffff);
    const me0 = await c.me().catch(() => ({}));
    const cur = me0.outfit || {};
    const outfit = {
      outfitSchema: 15,
      hat: rnd(OUTFIT_MAX.hat), top: rnd(OUTFIT_MAX.top), pants: rnd(OUTFIT_MAX.pants), shoe: rnd(OUTFIT_MAX.shoe),
      hatC: hex(), topC: hex(), pantsC: hex(), shoeC: hex(), strapC: hex(),
      skinTone: 1 + rnd(6),
      aura: null, cape: null, eyeFx: null, hatFx: null, wings: null,
      topFx: null, pantsFx: null, shoeFx: null, glasses: null,
      faceMask: null, handProp: null, torsoDecal: null, pantsPattern: null, shoeCosmetic: null,
    };
    const r = await c.saveOutfit({ outfit });
    if (r && r.ok === false) return '❌ Server menolak save-outfit: ' + JSON.stringify(r).slice(0, 120);
    c._outfitCache = outfit; // biar presence berikutnya pakai outfit baru
    // VERIFY via me() — jangan percaya ok saja
    const me2 = await c.me().catch(() => ({}));
    const saved = (me2.outfit && me2.outfit.hat != null) ? me2.outfit : null;
    return `🎲 <b>Outfit random terpasang${saved ? ' (terverifikasi)' : ''}</b>\n<code>${outfitShort(saved || outfit)}</code>` +
      (saved ? '' : '\n⚠️ me() belum nunjukin outfit — cek lagi dgn /outfit now');
  } catch (e) {
    return '❌ Outfit gagal: ' + String(e.message).slice(0, 120);
  }
}

async function hSetKey(pk) {
  pk = String(pk || '').trim();
  if (!pk) return `🔑 Pakai: <code>/setkey &lt;private_key_base58&gt;</code>`;
  try {
    const bs58 = require('bs58');
    const nacl = require('tweetnacl');
    const raw = bs58.default ? bs58.default.decode(pk) : bs58.decode(pk);
    if (raw.length !== 64) return '❌ Key gak valid (bukan 64 byte). Kirim base58 secret key Solana.';
    const pub = nacl.sign.keyPair.fromSecretKey(raw).publicKey;
    const b58 = bs58.default ? bs58.default.encode(pub) : bs58.encode(pub);
    const cfgmod = require('../config');
    if (process.env.KINTARA_ACCOUNT) {
      // MODE MULTI-ACCOUNT: persist ke accounts.json (bukan .env), lalu update in-place
      require('../lib/accounts').update(process.env.KINTARA_ACCOUNT, { wallet: pk });
    } else {
      cfgmod.persistEnv('WALLET_PRIVATE_KEY', pk); // mode single-account lama
    }
    // PENTING: object config di module uda nyimpen nilai LAMA sejak boot —
    // update in-place biar KintaraClient.create() baca key baru
    cfgmod.config.walletPrivateKey = pk;
    cfgmod.config.playerId = ''; // jangan bawa player id akun lama
    for (const k of Object.keys(process.env)) if (k === 'MY_PLAYER_ID') delete process.env[k];
    try { require('fs').chmodSync(require('path').join(__dirname, '..', '.env'), 0o600); } catch {}
    cli = null; player = null; cliAt = 0; // force relogin dgn wallet baru
    const c = await getClient();
    // detail akun + levels ala /skills
    const pid = player?.id || ((await c.me().catch(() => ({})))?.player?.id);
    const st = await c.playerStats(pid).catch(() => ({}));
    const xp = st.skillXp || {};
    const avg = Number.isFinite(Number(st.avg)) ? Number(st.avg) : '?';
    const lvl = (v) => { try { return levelFromTotalXp(v || 0); } catch { return '?'; } };
    const lv = `⚔️ combat ${lvl(xp.combat)} • 🪓 wood ${lvl(xp.woodcutting)} • ⛏ mining ${lvl(xp.mining)}\n🎣 fishing ${lvl(xp.fishing)} • 🍳 cooking ${lvl(xp.cooking)} • 🔨 smithing ${lvl(xp.smithing)}`;
    const meP = (await c.me().catch(() => ({})))?.player || {};
  const nm = player?.display_name || player?.displayName || meP.display_name || meP.displayName || '';
    return `✅ Private key diganti & AKTIF.\n👛 Wallet: <code>${b58}</code>\n👤 Akun: <b>${nm || '(belum ada nama)'}</b> (id ${pid || '?'})\n📊 Avg lvl ${avg}\n${lv}`;
    tg.send(msg).catch(() => {});
    return msg;
  } catch (e) {
    return '❌ Gagal: ' + String(e.message).slice(0, 120);
  }
}

function hHelp() {
  return `🤖 <b>Kintara Bot — Commands</b>\n` +
    `/status — bot status &amp; inventory\n/skills — skill levels, XP, avg level\n/balance — gold/$KINS/resources\n/market — marketplace prices\n/server — live server queues\n/version — current game version\n/quest — daily quests (auto-claim)\n/spinner — 🎡 free spin wheel (12h)\n/diag — auth, shard, process\n\n` +
    `/rock — mining stone+coal ⛏ (di POND — node rapat, rate 3x world)\n/stone — mining khusus stone 🪨\n/coal — mining khusus coal ⬛\n/wood — woodcutting 🪓\n/fish — fishing 🎣 + auto-masak jadi cooked 🍳 (1 flow)\n/cook (alias /cooking) — masak semua ikan mentah doang 🍳\n/combat — hunt zombie ⚔️ (/combat boss = dragon 🐉)\n/auto — automatic orchestrator (smart switching) 🧠\n/stop — stop all\n/outfit — 🎲 pasang outfit random baru (char gak polos)\n/outfit now — lihat outfit yang lagi dipakai\n/tutorial — 📖 auto tutorial akun baru (28 step)\n/setkey atau /pk — ganti private key wallet 🔑\n/help — command list\n\n` +
    `<i>1 akun = 1 aktivitas (aman dari anti-cheat). Combat pakai bank-first + auto-survival.</i>`;
}

// ---- command map ----
const commands = {
  auto: () => startAuto(),
  rock: () => startActivity('rock', (ctx) => loops.runRock(ctx)),
  stone: () => startActivity('stone', (ctx) => loops.runRock(ctx), { mode: 'stone' }),
  coal: () => startActivity('coal', (ctx) => loops.runRock(ctx), { mode: 'coal' }),
  cook: () => startActivity('cook', (ctx) => loops.runCook(ctx)), // masak semua ikan mentah doang
  cooking: () => startActivity('cook', (ctx) => loops.runCook(ctx)), // alias /cooking
  wood: () => startActivity('wood', (ctx) => loops.runWood(ctx)),
  combat: (args) => {
    const boss = ['boss', 'dragon', 'b'].includes(String(args[0] || '').toLowerCase());
    return startActivity(boss ? 'boss' : 'combat', (ctx) => loops.runCombat(ctx, { dragon: boss }));
  },
  spinner: () => startActivity('spinner', (ctx) => loops.runSpinner(ctx)),
  tutorial: () => startActivity('tutorial', (ctx) => loops.runTutorial(ctx)),
  fish: () => startActivity('fish', (ctx) => loops.runFish(ctx)),
  status: hStatus,
  skills: hSkills,
  quest: hQuest,
  market: hMarket,
  harga: hMarket,
  server: hServer,
  servers: hServer,
  version: hVersion,
  versi: hVersion,
  balance: hBalance,
  saldo: hBalance,
  diag: hDiag,
  stop: stopActivity,
  setkey: (args) => hSetKey(args.join(' ')),
  pk: (args) => hSetKey(args.join(' ')), // alias /pk — ganti private key wallet
  outfit: (args) => hOutfit(args), // /outfit random baru | /outfit now lihat sekarang
  help: hHelp,
  start: hHelp,
};

// ---- boot ----
(async () => {
  if (!config.telegramToken) {
    log('TELEGRAM_BOT_TOKEN kosong — bikin bot via @BotFather, taruh token di .env (TELEGRAM_BOT_TOKEN=...), restart.');
    process.exit(1);
  }
  log(`BOOT telegram-ctl${process.env.KINTARA_ACCOUNT ? ' [akun: ' + process.env.KINTARA_ACCOUNT + ']' : ''} — login kintara...`);
  try {
    await getClient();
    log('login ok, player=' + (player?.displayName || player?.id));
  } catch (e) {
    // TANPA WALLET PK: bot tetap jalan — user bisa isi key nanti via /pk <key>
    log('login awal gagal: ' + e.message.slice(0, 100) + ' — bot tetap jalan. Kirim /pk <private_key> di Telegram untuk set wallet.');
    setTimeout(() => tg.send('🤖 Bot aktif tanpa wallet.\n🔑 Kirim <code>/pk &lt;private_key_base58&gt;</code> untuk set wallet, lalu /help.').catch(() => {}), 3000);
  }
  // ===== PATCH: mode wallet detection =====
  // 1 wallet → SEMUA command aktif. >1 wallet → cuma /status & /skills (multi-akun = hanya monitoring).
  const { loadPks } = require('../lib/parseWallets');
  const _pkCount = (() => { try { return loadPks().length; } catch { return 1; } })();
  const SINGLE = _pkCount <= 1; // 0 wallet (belum ada PK) dianggap single — biar /pk tetap bisa dipakai untuk set key pertama
  const LOCKED_CMDS = new Set(['stone','coal','boss','spinner','tutorial','setkey','pk','start']);
  if (!SINGLE) {
    for (const k of LOCKED_CMDS) commands[k] = () => `🔒 Multi-wallet mode (${_pkCount} wallet di .env) — command nonaktif. Tersedia: /status /skills /rock /wood /combat /fish /cook /auto /stop.`;
    // ===== MULTI MODE: /rock /wood /combat /fish /cook /auto → jalankan aktivitas itu di SEMUA wallet (screen kintara-farm) =====
    const multiMode = (mode, label) => async () => {
      const { execSync, spawn } = require('child_process');
      try { execSync('screen -S kintara-farm -X quit 2>/dev/null || true'); } catch {}
      try { execSync("pkill -f 'tools/kintara-simple.js' 2>/dev/null || true"); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      // jalankan di screen 'kintara-farm' biar konsisten dgn /stop (screen -X quit) & gampang dicek
      const child = spawn('screen', ['-dmS', 'kintara-farm', 'bash', '-c',
        `cd /tmp/kintara-ref && KINTARA_MULTI_MODE=${mode} KINTARA_MULTI_SPREAD=1 node tools/kintara-simple.js >> recon/simple.log 2>&1`],
        { detached: true, stdio: 'ignore' });
      child.unref();
      log(`[multi] mode ${mode} dimulai untuk ${_pkCount} wallet`);
      return panel(`${label} (MULTI) — MULAI`, [
        ['Wallet', `${_pkCount} wallet paralel`],
        ['Mode', label],
        ['Target', 'jalan terus sampai /stop'],
      ], '🚀');
    };
    commands['rock'] = multiMode('rock', '⛏️ Mining stone+coal');
    commands['wood'] = multiMode('wood', '🪓 Woodcutting');
    commands['combat'] = multiMode('combat', '⚔️ Combat');
    commands['fish'] = multiMode('fish', '🎣 Fishing + cooking');
    commands['cook'] = multiMode('cook', '🍳 Cooking');
    commands['cooking'] = commands['cook'];
    commands['auto'] = multiMode('auto', '🧠 AUTO (fase F1–F4)');
    // /stop di multi mode = matikan runner farm (screen kintara-farm / proses kintara-simple)
    commands['stop'] = async () => {
      const { execSync } = require('child_process');
      let killed = [];
      try { killed.push(execSync('screen -S kintara-farm -X quit 2>&1 || true').toString().trim() && 'screen kintara-farm'); } catch {}
      try {
        const out = execSync("pkill -f 'tools/kintara-simple.js' && echo ok || echo none").toString().trim();
        if (out === 'ok') killed.push('proses kintara-simple');
      } catch {}
      log('[stop-multi] runner dimatikan: ' + (killed.join(', ') || 'tidak ada yang jalan'));
      return killed.length ? `⏹️ STOP multi-wallet: ${killed.join(' + ')} dimatikan.` : `⏹️ Gak ada runner farm yang jalan.`;
    };
    log(`[mode] MULTI-WALLET (${_pkCount} wallet) — /status /skills /stop /rock /wood /combat /fish /cook /auto aktif`);
  } else {
    log('[mode] SINGLE-WALLET — semua command aktif');
  }
  // =======================================
  // menu command native (muncul pas tekan "/" di Telegram)
  const tgMenu = [
    { command: 'auto', description: '🧠 Smart auto: cycle semua aktivitas' },
    { command: 'rock', description: '⛏️ Mining stone+coal (POND)' },
    { command: 'stone', description: '🪨 Mining khusus stone' },
    { command: 'coal', description: '⬛ Mining khusus coal' },
    { command: 'cook', description: '🍳 Masak ikan mentah jadi cooked' },
    { command: 'cooking', description: '🍳 Masak ikan mentah (alias /cook)' },
    { command: 'wood', description: '🪓 Woodcutting' },
    { command: 'combat', description: '⚔️ Hunt zombie (/combat boss 🐉 = dragon)' },
    { command: 'fish', description: '🎣 Fishing + cooking' },
    { command: 'spinner', description: '🎡 Free spin wheel (12h)' },
    { command: 'tutorial', description: '📖 Auto tutorial akun baru' },
    { command: 'status', description: '📊 Bot status & inventory' },
    { command: 'skills', description: '📈 Skill levels, XP, avg level' },
    { command: 'quest', description: '📋 Daily quests (auto-claim)' },
    { command: 'market', description: '🛍️ Marketplace prices' },
    { command: 'server', description: '🌐 Live server queues' },
    { command: 'version', description: '🧩 Current game version' },
    { command: 'balance', description: '💰 Gold / $KINS / resources' },
    { command: 'diag', description: '🔧 Auth, shard, process' },
    { command: 'setkey', description: '🔑 Ganti private key wallet' },
    { command: 'pk', description: '🔑 Ganti private key wallet (alias /setkey)' },
    { command: 'outfit', description: '🎲 Pasang outfit random | /outfit now' },
    { command: 'stop', description: '⏹️ Stop semua aktivitas' },
    { command: 'help', description: '📖 Command list' },
  ].map((c) => ({ command: c.command, description: c.description.slice(0, 256) }));
  // menu native: kalau multi-wallet, tampilkan hanya status & skills
  const menuFinal = SINGLE ? tgMenu : tgMenu.filter((c) => ['status', 'skills', 'stop', 'auto', 'rock', 'wood', 'combat', 'fish', 'cook', 'help'].includes(c.command));
  await tg.setMyCommands(menuFinal).catch(() => {});
  log('menu command terpasang (' + menuFinal.length + ' cmd)');
  // PATCH PRECONNECT: warm-up — siapkan server list + presence awal biar command pertama gak nunggu ('montir' siap)
  try {
    const c0 = await getClient();
    const srv = await c0.servers().catch(() => null);
    const free = (srv?.servers || []).filter((x) => !x.requiresMembership && !x.full)
      .sort((a, b) => (a.queueLength || 0) - (b.queueLength || 0))[0];
    if (free) log(`[preconnect] server siap: ${free.name} (${free.zone}) queue=${free.queueLength ?? 0}`);
  } catch (e) { log('[preconnect] skip: ' + String(e.message).slice(0, 50)); }
  await tg.send('🤖 Kintara farm bot ONLINE — /help').catch(() => {});
  // WATCHDOG: aktivitas diam >10 mnt (loop hang/nyangkut) = paksa STOP + kabari user;
  // masih macet 3 mtk kemudian = exit → keeper restart proses (bot selalu hidup lagi).
  let pollFails = 0; // fetch-failure BERUNTUN → exit, keeper restart = koneksi TCP Telegram fresh
  const hzState = humanizerState();
  // PATCH AUTOSTART: KINTARA_AUTOSTART=1 → bot langsung farming (auto cycle) tanpa nunggu command
  // MULTI mode: JANGAN autostart farming di proses ctl (bentrok dgn kintara-farm multi-wallet — 2 sesi 1 akun = kick)
  if (String(process.env.KINTARA_AUTOSTART || '0') === '1') {
    if (!SINGLE) log('[autostart] MULTI mode — skip (farming via kintara-farm, command /rock /wood dll tersedia)');
    else { log('[autostart] AUTO mode dinyalakan otomatis'); try { startAuto(); } catch (e) { log('autostart err: ' + e.message); } }
  }
  for (;;) {
    try { await humanizerTick(hzState); } catch (e) { log('humanizer err: ' + e.message); }
    try { const ok = await tg.pollCommands(commands); pollFails = ok === false ? pollFails + 1 : 0; } catch (e) { pollFails++; log('poll err: ' + e.message); }
    if (pollFails > 0) await sleep(5000); // 429/Bad Gateway: mundur 5 dtk sebelum poll lagi — jangan spam API
    if (pollFails >= 15) { log('[telegram] 15x gagal poll beruntun — exit (keeper restart, koneksi fresh)'); process.exit(3); }
    if (current) {
      const staleMs = Date.now() - (current.ctx._lastBeat || current.startedAt);
      if (staleMs > 10 * 60000 && !current.ctx._stop) {
        current.ctx._stop = true;
        log(`[watchdog] ${current.name} diam ${Math.round(staleMs / 60000)} mnt — paksa STOP`);
        await tg.send(`⚠️ [watchdog] ${current.name} macet ${Math.round(staleMs / 60000)} mnt — auto-STOP. Kirim command lagi buat lanjut.`).catch(() => {});
      } else if (staleMs > 13 * 60000 && current.ctx._stop) {
        log('[watchdog] masih macet setelah STOP — restart proses (keeper auto-restart)');
        process.exit(2);
      }
    }
    await sleep(1500);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
