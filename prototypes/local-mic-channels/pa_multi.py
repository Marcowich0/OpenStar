#!/usr/bin/env python3
"""Browser-free control: ONE PulseAudio client (one pa_context) recording from several
sources at once, roughly the way a browser's audio process does (float32, 10 ms fragsize,
ADJUST_LATENCY, streams opened one after another). Prints per-stream dominant frequency
(zero-crossing estimate), RMS and the share of exactly-zero samples.

usage: pa_multi.py [--channels N] [--stagger S] [--seconds T] source [source ...]
"""
import argparse, ctypes as C, math, struct, time

pa = C.CDLL("libpulse.so.0")
pa.pa_mainloop_new.restype = C.c_void_p
pa.pa_mainloop_get_api.restype = C.c_void_p
pa.pa_mainloop_get_api.argtypes = [C.c_void_p]
pa.pa_mainloop_iterate.argtypes = [C.c_void_p, C.c_int, C.c_void_p]
pa.pa_context_new.restype = C.c_void_p
pa.pa_context_new.argtypes = [C.c_void_p, C.c_char_p]
pa.pa_context_connect.argtypes = [C.c_void_p, C.c_char_p, C.c_int, C.c_void_p]
pa.pa_context_get_state.argtypes = [C.c_void_p]


class SampleSpec(C.Structure):
    _fields_ = [("format", C.c_int), ("rate", C.c_uint32), ("channels", C.c_uint8)]


class BufferAttr(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ("maxlength", "tlength", "prebuf", "minreq", "fragsize")]


pa.pa_stream_new.restype = C.c_void_p
pa.pa_stream_new.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(SampleSpec), C.c_void_p]
pa.pa_stream_connect_record.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(BufferAttr), C.c_int]
pa.pa_stream_get_state.argtypes = [C.c_void_p]
pa.pa_stream_readable_size.argtypes = [C.c_void_p]
pa.pa_stream_readable_size.restype = C.c_size_t
pa.pa_stream_peek.argtypes = [C.c_void_p, C.POINTER(C.c_void_p), C.POINTER(C.c_size_t)]
pa.pa_stream_drop.argtypes = [C.c_void_p]

ap = argparse.ArgumentParser()
ap.add_argument("--channels", type=int, default=1)
ap.add_argument("--stagger", type=float, default=0.3)
ap.add_argument("--seconds", type=float, default=3.0)
ap.add_argument("sources", nargs="+")
args = ap.parse_args()
RATE, CH = 48000, args.channels

ml = pa.pa_mainloop_new()
ctx = pa.pa_context_new(pa.pa_mainloop_get_api(ml), b"pa_multi")
pa.pa_context_connect(ctx, None, 0, None)
while pa.pa_context_get_state(ctx) != 4:
    if pa.pa_context_get_state(ctx) in (5, 6):
        raise SystemExit("context failed")
    pa.pa_mainloop_iterate(ml, 1, None)

streams, bufs = [], []


def pump(deadline):
    while time.monotonic() < deadline:
        pa.pa_mainloop_iterate(ml, 1, None)
        for i, s in enumerate(streams):
            if pa.pa_stream_get_state(s) != 2:  # PA_STREAM_READY
                continue
            while 0 < pa.pa_stream_readable_size(s) < (1 << 30):
                p, n = C.c_void_p(), C.c_size_t()
                pa.pa_stream_peek(s, C.byref(p), C.byref(n))
                if n.value:
                    bufs[i].extend(C.string_at(p, n.value) if p.value else b"\0" * n.value)
                pa.pa_stream_drop(s)


for src in args.sources:
    ss = SampleSpec(5, RATE, CH)  # PA_SAMPLE_FLOAT32LE
    attr = BufferAttr(0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 480 * 4 * CH)
    s = pa.pa_stream_new(ctx, src.encode(), C.byref(ss), None)
    pa.pa_stream_connect_record(s, src.encode(), C.byref(attr), 0x2000)  # ADJUST_LATENCY
    streams.append(s)
    bufs.append(bytearray())
    pump(time.monotonic() + args.stagger)

for b in bufs:
    b.clear()  # measure only the period where all streams are open
pump(time.monotonic() + args.seconds)

for src, b in zip(args.sources, bufs):
    x = struct.unpack(f"<{len(b) // 4}f", bytes(b))[::CH]  # first channel
    if not x:
        print(f"{src}: NO DATA")
        continue
    rms = math.sqrt(sum(v * v for v in x) / len(x))
    zc = sum(1 for a, c in zip(x, x[1:]) if (a < 0) != (c < 0))
    zeros = sum(1 for v in x if v == 0.0) / len(x)
    secs = len(x) / RATE
    print(f"{src}: {secs:.2f}s received, ~{zc / 2 / secs:.0f} Hz, rms {20 * math.log10(rms + 1e-12):.1f} dBFS, zero samples {zeros:.0%}")
