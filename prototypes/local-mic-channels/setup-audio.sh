#!/usr/bin/env bash
# Creates two virtual 4-channel PipeWire sources and feeds each with a 4-tone signal:
#   ch1 220 Hz, ch2 330 Hz, ch3 440 Hz, ch4 550 Hz
#   mic4_aux   positions AUX0 AUX1 AUX2 AUX3   (like a UMC404HD in the "Pro Audio" profile)
#   mic4_quad  positions FL FR RL RR           (like the "Analog Surround 4.0" profile)
#   mic4_aiff  remap of mic4_aux to FL FC FR RC (the PulseAudio default 4-ch map Firefox asks for)
# plus, as a control, four independent mono virtual sources ind1..ind4 (220/330/440/550 Hz),
# each its own graph driver (unlike remap sources, which all follow mic4_aux).
set -euo pipefail
RATE=48000

make_source() { # name channel_map
  pactl load-module module-null-sink \
    media.class=Audio/Source/Virtual sink_name="$1" \
    channels=4 channel_map="$2" rate=$RATE \
    sink_properties="device.description=Virtual-4ch-$1" >/dev/null
}

feed() { # name pw-channel-map [sox synth args]
  # sox: one sine per channel, 1 h long, raw s16le, piped into a playback stream.
  # WirePlumber will not auto-link a playback stream into an Audio/Source/Virtual node
  # (--target is ignored and it lands on the default sink), so autoconnect is off and
  # the four ports are linked by hand with pw-link. Identical channel maps => no remix.
  local n; n=$(tr ',' '\n' <<<"$2" | wc -l)
  local synth=${3:-sine 220 sine 330 sine 440 sine 550}
  (sox -q -n -r $RATE -c "$n" -b 16 -e signed -t raw - \
      synth 3600 $synth gain -12 \
    | pw-cat --playback --raw --rate $RATE --channels "$n" \
        --channel-map "$2" --format s16 \
        -P "{ node.autoconnect = false node.name = feed_$1 }" - \
    ) >/tmp/feed-"$1".log 2>&1 &
  for _ in $(seq 50); do pw-link -o | grep -q "^feed_$1:" && break; sleep 0.1; done
  local ch
  for ch in ${2//,/ }; do pw-link "feed_$1:output_$ch" "$1:input_$ch"; done
}

# A plain stereo sink so the browsers' AudioContext has a real output device.
pactl load-module module-null-sink sink_name=dummy_out \
  sink_properties=device.description=Dummy-Output >/dev/null
pactl set-default-sink dummy_out

make_source mic4_aux  aux0,aux1,aux2,aux3
make_source mic4_quad front-left,front-right,rear-left,rear-right
feed mic4_aux  AUX0,AUX1,AUX2,AUX3
feed mic4_quad FL,FR,RL,RR

pactl load-module module-remap-source master=mic4_aux source_name=mic4_aiff \
  master_channel_map=aux0,aux1,aux2,aux3 channel_map=front-left,front-center,front-right,rear-center \
  source_properties=device.description=Virtual-4ch-aiff >/dev/null

f=(0 220 330 440 550)
for i in 1 2 3 4; do
  pactl load-module module-null-sink media.class=Audio/Source/Virtual sink_name=ind$i \
    channels=1 channel_map=mono rate=$RATE sink_properties=device.description=Indep-ch$i >/dev/null
  feed ind$i MONO "sine ${f[$i]}"
done
sleep 1

echo "[setup] sources:" >&2
pactl list short sources >&2
pactl list short sink-inputs >&2
