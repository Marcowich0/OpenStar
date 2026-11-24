#!/usr/bin/env bash
# Browser-free control for the concurrent-capture problem: one libpulse client (pa_multi.py)
# recording 4 sources at once. Run via: run.sh ./control.sh
set -euo pipefail
for i in 1 2 3 4; do
  pactl load-module module-remap-source master=mic4_aux source_name=mic_ch$i \
    master_channel_map=aux$((i - 1)) channel_map=mono >/dev/null
done
sleep 1
for r in 1 2 3; do
  echo "-- one client, 4 independent mono sources (ind1..4), round $r"
  python3 pa_multi.py ind1 ind2 ind3 ind4
done
for r in 1 2 3; do
  echo "-- one client, 4 mono remap sources of mic4_aux, round $r"
  python3 pa_multi.py mic_ch1 mic_ch2 mic_ch3 mic_ch4
done
echo "-- 4 separate parec processes on the 4 remap sources"
for i in 1 2 3 4; do
  (parec -d mic_ch$i --channels=1 --format=float32le --rate=48000 --raw 2>/dev/null \
     | head -c $((48000 * 4 * 3)) > /tmp/p$i.raw) &
  sleep 0.3
done
wait
for i in 1 2 3 4; do
  echo "mic_ch$i (parec): $(sox -t raw -r 48000 -c 1 -b 32 -e float /tmp/p$i.raw -n stat 2>&1 \
    | awk '/Length/{l=$3} /Rough/{f=$3} END{print l "s, ~" f " Hz"}')"
done
