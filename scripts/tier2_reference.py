# scripts/tier2_reference.py — design §15 Tier 2 reference host (numpy + onnxruntime CPU EP), run inside the venv:
#   <task>\venv\Scripts\python.exe scripts\tier2_reference.py [--evidence <dir>] [--models-src <dir>]
# Replicates musetric's vocals host independently of the JS engine: numpy STFT (torch-reflect padding, periodic Hann),
# stft_repr packing [1, 2050, 1100, 2] (packed = freq·2 + channel), the fp16 core on the ORT CPU EP, complex mask multiply,
# numpy iSTFT with the Σw² envelope, the unit_plan.rs::vocals loop with the VocalsV1 Hamming fold, and stem_signal.rs's
# joint-peak normalization. Picks the gate window ONCE and deterministically (loudest 484,659-sample window on the
# 44,100-sample grid, ties → smallest start) and writes it to evidence/ref_tier2/window.json for the JS parity test.
# A37: if the CPU EP cannot create the session, writes evidence/parity_tier2.json { cpuEp: 'unavailable', error } and exits 0
# WITHOUT writing window.json (the parity test then skips gate (a) with CPU_EP_UNAVAILABLE).
import argparse
import datetime as dt
import json
import os
import platform
import sys
import time

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TASK = os.path.abspath(os.path.join(REPO, ".."))

N_FFT = 2048
HOP = 441
FRAMES = 1100
CHUNK = HOP * (FRAMES - 1)          # 484,659
STEP = min(8 * 44100, CHUNK)        # 352,800 (VOCALS_STEP_SECONDS · sample_rate, capped at the chunk)
PAD = N_FFT // 2
MAX_PEAK = 0.9
INPUT_NAME = "stft_repr"
OUTPUT_NAME = "masks"
SAMPLE_RATE = 44100


def hann_periodic(n):
    i = np.arange(n, dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * i / n)


WINDOW = hann_periodic(N_FFT)


def read_wav(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    return sr, data[:, 0].copy(), data[:, 1].copy()


def write_wav_f32(path, left, right, sr=SAMPLE_RATE):
    import soundfile as sf
    sf.write(path, np.stack([left, right], axis=1).astype(np.float32), sr, subtype="FLOAT")


def peak_of(left, right):
    return float(max(np.max(np.abs(left), initial=0.0), np.max(np.abs(right), initial=0.0)))


def apply_scale(x, scale):
    # stem_signal.rs apply_scale: (f64(value) · scale) as f32
    return (x.astype(np.float64) * scale).astype(np.float32)


def normalize_peak(left, right, max_peak=MAX_PEAK):
    peak = peak_of(left, right)
    scale = 1.0 if (peak == 0.0 or peak <= max_peak) else max_peak / peak
    return apply_scale(left, scale), apply_scale(right, scale), scale


def stft(x):
    """x: float32[CHUNK] → complex128[1025, FRAMES]; torch.stft(center=True, pad_mode='reflect', periodic hann, onesided)."""
    assert x.shape[0] == CHUNK, x.shape
    padded = np.pad(x.astype(np.float64), PAD, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    assert frames.shape[0] == FRAMES, frames.shape
    return np.fft.rfft(frames * WINDOW, axis=1).T   # [1025, FRAMES]


def istft(spec):
    """spec: complex128[1025, FRAMES] → float64[CHUNK]; overlapAdd.wgsl.ts: Σ frame·w / max(Σw², 1e-8), trimmed by PAD."""
    frames = np.fft.irfft(spec.T, n=N_FFT, axis=1) * WINDOW   # [FRAMES, N_FFT]
    total = CHUNK + N_FFT
    ola = np.zeros(total, dtype=np.float64)
    env = np.zeros(total, dtype=np.float64)
    w2 = WINDOW * WINDOW
    for t in range(FRAMES):
        off = t * HOP
        ola[off:off + N_FFT] += frames[t]
        env[off:off + N_FFT] += w2
    out = ola / np.maximum(env, 1e-8)
    return out[PAD:PAD + CHUNK]


def pack(spec_l, spec_r):
    """→ float32[1, 2050, FRAMES, 2] with packed = freq·2 + channel and [re, im] last."""
    arr = np.empty((1025, 2, FRAMES, 2), dtype=np.float32)
    arr[:, 0, :, 0] = spec_l.real
    arr[:, 0, :, 1] = spec_l.imag
    arr[:, 1, :, 0] = spec_r.real
    arr[:, 1, :, 1] = spec_r.imag
    return arr.reshape(1, 2050, FRAMES, 2)


def run_unit(session, left_chunk, right_chunk):
    """One zero-padded unit (float32[CHUNK] × 2) → raw vocals (float64[CHUNK] × 2), timing in ms."""
    sl, sr = stft(left_chunk), stft(right_chunk)
    feed = pack(sl, sr)
    t0 = time.time()
    masks = session.run([OUTPUT_NAME], {INPUT_NAME: feed})[0]
    ms = (time.time() - t0) * 1000.0
    assert masks.shape == (1, 2050, FRAMES, 2), masks.shape
    m = masks.reshape(1025, 2, FRAMES, 2).astype(np.float64)
    mc = m[..., 0] + 1j * m[..., 1]
    return istft(sl * mc[:, 0, :]), istft(sr * mc[:, 1, :]), ms


def plan_units(samples):
    """unit_plan.rs::vocals — duplicates kept."""
    units = []
    offset = 0
    while offset < samples:
        if offset + CHUNK <= samples:
            units.append((offset, CHUNK))
        elif samples >= CHUNK:
            units.append((samples - CHUNK, CHUNK))
        else:
            units.append((0, samples))
        offset += STEP
    return units


HAMMING = (0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(CHUNK, dtype=np.float64) / CHUNK)).astype(np.float32)


def separate_clip(session, xn_l, xn_r, log):
    """Full host: plan → per-unit run → Hamming fold (f32 target/counter, f64 intermediate) → raw vocals (float32)."""
    n = xn_l.shape[0]
    units = plan_units(n)
    target = [np.zeros(n, dtype=np.float32), np.zeros(n, dtype=np.float32)]
    counter = np.zeros(n, dtype=np.float32)
    times = []
    for i, (start, length) in enumerate(units):
        cl = np.zeros(CHUNK, dtype=np.float32)
        cr = np.zeros(CHUNK, dtype=np.float32)
        cl[:length] = xn_l[start:start + length]
        cr[:length] = xn_r[start:start + length]
        vl, vr, ms = run_unit(session, cl, cr)
        times.append(round(ms))
        w = HAMMING[:length].astype(np.float64)
        target[0][start:start + length] = (target[0][start:start + length].astype(np.float64) + vl[:length] * w).astype(np.float32)
        target[1][start:start + length] = (target[1][start:start + length].astype(np.float64) + vr[:length] * w).astype(np.float32)
        counter[start:start + length] = (counter[start:start + length].astype(np.float64) + w).astype(np.float32)
        log(f"  unit {i + 1}/{len(units)} [{start}, {start + length}) {ms:.0f} ms")
    d = np.maximum(counter, 1e-10)
    raw_l = (target[0] / d).astype(np.float32)
    raw_r = (target[1] / d).astype(np.float32)
    return raw_l, raw_r, units, times


def db(a, b):
    """10·log10(Σa² / Σb²) over both channels (a, b: lists of arrays)."""
    num = sum(float(np.sum(x.astype(np.float64) ** 2)) for x in a)
    den = sum(float(np.sum(x.astype(np.float64) ** 2)) for x in b)
    if den == 0.0:
        return float("inf")
    return 10.0 * np.log10(num / den)


def merge_json(path, patch):
    cur = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8-sig") as f:
            try:
                cur = json.load(f)
            except json.JSONDecodeError:
                cur = {}
    cur.update(patch)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cur, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", default=os.path.join(TASK, "evidence"))
    ap.add_argument("--models-src", default=os.path.join(REPO, "models_src"))
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):          # Windows consoles may default to GBK; the log has Unicode math symbols
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    evidence = args.evidence
    ref_dir = os.path.join(evidence, "ref_tier2")
    parity_path = os.path.join(evidence, "parity_tier2.json")
    core = os.path.join(args.models_src, "duality_student_core_t1100.onnx")
    data = core + ".data"
    log = lambda *a: print(*a, flush=True)  # noqa: E731
    os.makedirs(evidence, exist_ok=True)

    if not (os.path.exists(core) and os.path.exists(data)):
        log(f"tier2_reference: TIER2_BYTES_MISSING {core} / {data} — run scripts/fetch_models.ps1 -Tier2")
        sys.exit(2)

    import onnxruntime as ort
    env = {"python": platform.python_version(), "numpy": np.__version__, "onnxruntime": ort.__version__}
    so = ort.SessionOptions()
    so.log_severity_level = 3
    t0 = time.time()
    try:
        session = ort.InferenceSession(core, so, providers=["CPUExecutionProvider"])
    except Exception as e:  # noqa: BLE001 — A37 decision path
        err = f"{type(e).__name__}: {e}"
        log(f"tier2_reference: CPU_EP_UNAVAILABLE {err}")
        merge_json(parity_path, {"cpuEp": "unavailable", "error": err[:2000], "env": env, "date": dt.datetime.now(dt.timezone.utc).isoformat()})
        sys.exit(0)
    session_ms = round((time.time() - t0) * 1000)
    names = ([i.name for i in session.get_inputs()], [o.name for o in session.get_outputs()])
    assert names == ([INPUT_NAME], [OUTPUT_NAME]), names
    log(f"tier2_reference: CPU EP session in {session_ms} ms, providers {session.get_providers()}")

    # --- clip25: xN and the deterministic loudest window ------------------------------------------------------------
    clip_path = os.path.join(REPO, "tests", "fixtures", "clip25.wav")
    sr, xl, xr = read_wav(clip_path)
    assert sr == SAMPLE_RATE, sr
    n = xl.shape[0]
    peak = peak_of(xl, xr)
    xn_l, xn_r, input_scale = normalize_peak(xl, xr)
    k_max = (n - CHUNK) // SAMPLE_RATE
    energies = []
    for k in range(k_max + 1):
        s = k * SAMPLE_RATE
        e = float(np.sum(xn_l[s:s + CHUNK].astype(np.float64) ** 2) + np.sum(xn_r[s:s + CHUNK].astype(np.float64) ** 2))
        energies.append(e)
    window_start = int(np.argmax(energies)) * SAMPLE_RATE      # argmax returns the FIRST maximum → ties → smallest s
    log(f"tier2_reference: clip25 n={n} peak={peak:.6f} inputScale={input_scale:.6f} window start={window_start} (k={window_start // SAMPLE_RATE} of 0..{k_max})")

    # --- single-unit host on the window (what the JS parity test reproduces) ------------------------------------------
    wl = xn_l[window_start:window_start + CHUNK].copy()
    wr = xn_r[window_start:window_start + CHUNK].copy()
    raw_l, raw_r, unit_ms = run_unit(session, wl, wr)
    raw_l32, raw_r32 = raw_l.astype(np.float32), raw_r.astype(np.float32)
    voc_l, voc_r, voc_scale = normalize_peak(raw_l32, raw_r32)
    res_l = (wl.astype(np.float64) - raw_l32.astype(np.float64)).astype(np.float32)
    res_r = (wr.astype(np.float64) - raw_r32.astype(np.float64)).astype(np.float32)
    inst_l, inst_r, inst_scale = normalize_peak(res_l, res_r)
    finite = bool(np.isfinite(voc_l).all() and np.isfinite(voc_r).all() and np.isfinite(inst_l).all() and np.isfinite(inst_r).all())
    log(f"tier2_reference: window unit {unit_ms:.0f} ms; raw vocals peak {peak_of(raw_l32, raw_r32):.4f} → vocals scale {voc_scale:.4f}; inst scale {inst_scale:.4f}; finite {finite}")

    # --- the 20 s instrumental clip, whole-clip host (gate b-instrumental reference) -------------------------------------
    inst_clip_rel = "tests/fixtures/clip20_inst.wav"
    inst_clip = os.path.join(REPO, *inst_clip_rel.split("/"))
    sr2, il, ir = read_wav(inst_clip)
    assert sr2 == SAMPLE_RATE, sr2
    in_l, in_r, inst_in_scale = normalize_peak(il, ir)
    log(f"tier2_reference: clip20_inst n={in_l.shape[0]} inputScale={inst_in_scale:.6f}")
    civ_l, civ_r, inst_units, inst_times = separate_clip(session, in_l, in_r, log)
    b_inst_db = db([in_l, in_r], [civ_l, civ_r])
    log(f"tier2_reference: python host (b-instrumental) 10·log10(Σmix²/Σvoc²) = {b_inst_db:.2f} dB over {len(inst_units)} units")

    # --- write reference files ---------------------------------------------------------------------------------------
    os.makedirs(ref_dir, exist_ok=True)
    write_wav_f32(os.path.join(ref_dir, "vocals_window.wav"), voc_l, voc_r)
    write_wav_f32(os.path.join(ref_dir, "inst_window.wav"), inst_l, inst_r)
    write_wav_f32(os.path.join(ref_dir, "raw_vocals_window.wav"), raw_l32, raw_r32)
    write_wav_f32(os.path.join(ref_dir, "inst_clip_vocals.wav"), civ_l, civ_r)
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    window = {
        "clip": "clip25.wav",
        "windowStart": window_start,
        "windowLen": CHUNK,
        "inputScale": input_scale,
        "sampleRate": SAMPLE_RATE,
        "instrumentalClip": inst_clip_rel,
        "instrumentalSource": "ccmixter_stems",
        "date": now_iso,
        "fixturePeak": peak,
        "windowRule": "argmax over s = k·44100, k = 0..floor((n − 484659)/44100), of Σ(L²+R²) over 484,659 samples of xN; ties → smallest s",
        "candidateEnergies": [round(e, 3) for e in energies],
        "files": {
            "vocals_window.wav": "normalize_peak(raw_vocals, 0.9) of the single-unit host on xN[windowStart : windowStart + windowLen]",
            "inst_window.wav": "normalize_peak(xN_window − raw_vocals, 0.9)",
            "raw_vocals_window.wav": "the fold output before normalization",
            "inst_clip_vocals.wav": "the host's raw vocals for the whole clip20_inst.wav (unit_plan.rs loop, Hamming fold)",
        },
        "host": {"stft": "numpy rfft, reflect pad 1024, periodic Hann 2048, hop 441, 1100 frames", "istft": "numpy irfft · w, Σw² envelope (guard 1e-8), trimmed 1024", "ep": "CPUExecutionProvider"},
        "env": env,
    }
    with open(os.path.join(ref_dir, "window.json"), "w", encoding="utf-8") as f:
        json.dump(window, f, indent=2)
        f.write("\n")
    merge_json(parity_path, {
        "cpuEp": "available",
        "error": None,
        "env": env,
        "reference": {
            "sessionMs": session_ms,
            "windowUnitMs": round(unit_ms),
            "windowStart": window_start,
            "inputScale": input_scale,
            "vocalsOutputScale": voc_scale,
            "instOutputScale": inst_scale,
            "finite": finite,
            "instrumentalClip": inst_clip_rel,
            "instrumentalSource": "ccmixter_stems",
            "instrumentalInputScale": inst_in_scale,
            "instrumentalUnits": [[s, l] for s, l in inst_units],
            "instrumentalUnitMs": inst_times,
            "pythonHost_bInstrumentalDb": round(b_inst_db, 2),
            "pythonHost_bInstrumentalFormula": "10·log10(Σmix² / Σvoc²), mix = xN of clip20_inst.wav, voc = python host raw vocals",
        },
        "date": now_iso,
    })
    log(f"tier2_reference: wrote {os.path.join(ref_dir, 'window.json')} and merged {parity_path}")


if __name__ == "__main__":
    main()
