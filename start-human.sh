#!/usr/bin/env bash
# ============ START — PROFIL MODE MANUSIA KONSERVATIF ============
# Untuk akun BARU yang belum pernah diflag. Pemakaian:
#   1. isi WALLET_PRIVATE_KEY akun baru di .env
#   2. ./start-human.sh
#   3. kontrol via Telegram seperti biasa (/auto, /stop, dst)
# Prinsip: farming pendek-pendek, sering istirahat, tidur panjang tiap jam makan.
cd "$(dirname "$0")"

export KINTARA_PHASE_MAX_MIN=6          # sesi aktivitas max 6 mnt (dulu 10)
export KINTARA_JITTER=0.35              # jeda internal diacak ±35% (lebih kacau = lebih manusia)

# Break istirahat: tiap 60–120 mnt jalan → istirahat 5–12 mnt (pendek, jangan menganggur lama)
export KINTARA_BREAK_EVERY_MIN_A=60
export KINTARA_BREAK_EVERY_MIN_B=120
export KINTARA_BREAK_DUR_MIN_A=5
export KINTARA_BREAK_DUR_MIN_B=12

# Tidur panjang: tiap 8–14 jam → tidur 2–5 jam (jam tidur bergantian alami)
export KINTARA_SLEEP_EVERY_H_A=8
export KINTARA_SLEEP_EVERY_H_B=14
export KINTARA_SLEEP_DUR_MIN_A=120
export KINTARA_SLEEP_DUR_MIN_B=300

mkdir -p recon
while true; do
  node tools/telegram-ctl.js >> recon/telegram-ctl-stdout.log 2>&1
  echo "[$(date -u +%H:%M:%S)] keeper-human: exit $? — restart 15s" >> recon/keeper.log
  sleep 15
done
