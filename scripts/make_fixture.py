"""scripts/make_fixture.py — build the test fixtures from ccMixter stems (run inside the venv).

Source: "Slow Motion Dream" by Steven M Bryant (ccMixter user stevieb357, upload 34740), CC BY 3.0.
Downloads the mix + five stems into models_src/fixture_src/ (gitignored; ccMixter needs a Referer header),
aligns the Lead Vocal stem to the mix (cross-correlation of 100 Hz RMS envelopes), picks the 25 s window
with the most Lead Vocal energy (1 s grid; fallback start 60 s when the alignment is ambiguous), and writes
  tests/fixtures/clip25.wav       16-bit stereo 44.1 kHz, joint peak 32767, exactly 1,102,500 frames
  tests/fixtures/clip25_48k.wav   the same clip resampled to 48 kHz (1,200,000 frames)
  tests/fixtures/clip20_inst.wav  20 s of Drums Left + Drums Right + Lead Guitar over the same window, joint peak 0.9
plus ../evidence/fixture.json (or $VS_EVIDENCE_DIR/fixture.json). Attribution lives in NOTICE.md only.
Fallback when ccMixter is unreachable: the spleeter audio_example.mp3 (same song, 10.945 s) -> clip10.wav.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

import numpy as np
import librosa
import soundfile as sf

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO, 'models_src', 'fixture_src')
FIX_DIR = os.path.join(REPO, 'tests', 'fixtures')
EVIDENCE_DIR = os.environ.get('VS_EVIDENCE_DIR') or os.path.join(os.path.dirname(REPO), 'evidence')

SR = 44100
REFERER = 'https://ccmixter.org/files/stevieb357/34740'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/130.0.0.0 Safari/537.36')
BASE = 'https://ccmixter.org/content/stevieb357/stevieb357_-_Slow_Motion_Dream'
FILES = {
    'mix':          (BASE + '.mp3',   9781334),
    'lead_vocal':   (BASE + '_3.mp3', 3202693),
    'backing_vocal': (BASE + '_5.mp3', 2445014),
    'drums_left':   (BASE + '_6.mp3', 2482935),
    'drums_right':  (BASE + '_1.mp3', 2504958),
    'lead_guitar':  (BASE + '_2.mp3', 2170372),
}
FALLBACK_URL = 'https://raw.githubusercontent.com/deezer/spleeter/master/audio_example.mp3'
LICENSE = 'CC BY 3.0'
LICENSE_URL = 'http://creativecommons.org/licenses/by/3.0/'


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def download(url, dest, expected_size=None, referer=None):
    """curl.exe with resume + retries (ccMixter is slow and closed a plain urllib connection early);
    urllib fallback when curl.exe is unavailable."""
    if os.path.exists(dest) and (expected_size is None or os.path.getsize(dest) == expected_size):
        return
    curl = shutil.which('curl.exe') or shutil.which('curl')
    if curl:
        for attempt in range(4):
            cmd = [curl, '-sS', '-L', '--retry', '5', '--retry-delay', '5', '--retry-all-errors', '-C', '-',
                   '-A', UA, '-o', dest, url]
            if referer:
                cmd[1:1] = ['-e', referer]
            subprocess.run(cmd, check=False)
            if os.path.exists(dest) and (expected_size is None or os.path.getsize(dest) == expected_size):
                return
            if os.path.exists(dest) and expected_size is not None and os.path.getsize(dest) > expected_size:
                os.remove(dest)
            print(f'retry {attempt + 1} for {url}', file=sys.stderr)
    else:
        headers = {'User-Agent': UA}
        if referer:
            headers['Referer'] = referer
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r, open(dest + '.part', 'wb') as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(dest + '.part', dest)
    if expected_size is not None and (not os.path.exists(dest) or os.path.getsize(dest) != expected_size):
        size = os.path.getsize(dest) if os.path.exists(dest) else 0
        raise RuntimeError(f'{url}: size {size} != expected {expected_size}')


def load_stereo(path):
    y, sr = librosa.load(path, sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    assert sr == SR
    return y.astype(np.float64)


def rms_envelope(y, hop=441):
    mono = y.mean(axis=0)
    n = (len(mono) // hop) * hop
    frames = mono[:n].reshape(-1, hop)
    return np.sqrt((frames ** 2).mean(axis=1))


def xcorr_peak(a, b, exclude):
    """Full cross-correlation via FFT. Returns (lag, peak/second-peak ratio) with lag such that b[t] ~ a[t + lag];
    the second peak is searched outside ±exclude samples around the first."""
    n = len(a) + len(b) - 1
    nfft = 1 << (n - 1).bit_length()
    fa = np.fft.rfft(a, nfft)
    fb = np.fft.rfft(b, nfft)
    xc = np.fft.irfft(fa * np.conj(fb), nfft)[:n]
    xc = np.roll(xc, len(b) - 1)                   # index k -> lag k - (len(b) - 1)
    lags = np.arange(-(len(b) - 1), len(a))
    k = int(np.argmax(xc))
    peak = float(xc[k])
    mask = np.abs(lags - lags[k]) > exclude
    second = float(xc[mask].max()) if mask.any() else 0.0
    ratio = peak / second if second > 0 else float('inf')
    return int(lags[k]), ratio


def align_envelope(mix, stem, hop=441):
    """Design's envelope method (100 Hz RMS envelopes), kept for the record."""
    a = rms_envelope(mix, hop)
    b = rms_envelope(stem, hop)
    lag, ratio = xcorr_peak(a - a.mean(), b - b.mean(), exclude=50)   # ±0.5 s
    return lag * hop, ratio


def align_waveform(mix, stem, decim=10):
    """Waveform cross-correlation at 4,410 Hz (the stem is literally a component of the mix, so the peak is sharp),
    refined at 44.1 kHz. Returns (lag_samples, ratio_coarse) with stem[t] ~ mix[t + lag]."""
    from scipy.signal import resample_poly
    a = resample_poly(mix.mean(axis=0), 1, decim)
    b = resample_poly(stem.mean(axis=0), 1, decim)
    lag_c, ratio = xcorr_peak(a, b, exclude=SR // decim // 2)        # ±0.5 s
    lag = lag_c * decim
    # refine ±decim samples at full rate on a 30 s segment of the stem where the overlap is valid
    am = mix.mean(axis=0)
    bm = stem.mean(axis=0)
    seg_len = 30 * SR
    s0 = max(0, -lag) + SR                                           # stem index start
    s0 = min(s0, max(0, len(bm) - seg_len - 1))
    seg = bm[s0:s0 + seg_len]
    best, best_v = lag, -np.inf
    for d in range(-decim, decim + 1):
        m0 = s0 + lag + d
        if m0 < 0 or m0 + len(seg) > len(am):
            continue
        v = float(np.dot(am[m0:m0 + len(seg)], seg))
        if v > best_v:
            best, best_v = lag + d, v
    return int(best), ratio


def to_int16_peak(y, peak_target):
    """Scale jointly so max|y| == peak_target (in int16 units) and round to int16."""
    p = float(np.abs(y).max())
    if p == 0:
        raise RuntimeError('silent clip')
    scaled = y * (peak_target / p)
    i16 = np.clip(np.rint(scaled), -32768, 32767).astype(np.int16)
    return i16, float(np.abs(i16).max())


def write_wav(path, i16, sr=SR):
    sf.write(path, i16.T, sr, subtype='PCM_16')


def main():
    os.makedirs(SRC_DIR, exist_ok=True)
    os.makedirs(FIX_DIR, exist_ok=True)
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    evidence = {
        'date': datetime.now(timezone.utc).isoformat(),
        'song': 'Slow Motion Dream', 'artist': 'Steven M Bryant (stevieb357)',
        'sourcePage': REFERER, 'license': LICENSE, 'licenseUrl': LICENSE_URL,
        'sources': {}, 'files': {},
    }

    try:
        for key, (url, size) in FILES.items():
            dest = os.path.join(SRC_DIR, os.path.basename(url))
            download(url, dest, size, referer=REFERER)
            evidence['sources'][key] = {'url': url, 'bytes': os.path.getsize(dest), 'sha256': sha256_of(dest), 'path': dest}
        fallback = False
    except Exception as e:  # noqa: BLE001
        print('ccMixter download failed:', repr(e), '-> fallback to spleeter audio_example.mp3', file=sys.stderr)
        fallback = True

    if fallback:
        dest = os.path.join(SRC_DIR, 'audio_example.mp3')
        download(FALLBACK_URL, dest)
        evidence['sources'] = {'mix': {'url': FALLBACK_URL, 'bytes': os.path.getsize(dest), 'sha256': sha256_of(dest), 'path': dest}}
        evidence['fixture'] = 'fallback-spleeter-audio_example'
        mix = load_stereo(dest)
        i16, pk = to_int16_peak(mix, 32767)
        out = os.path.join(FIX_DIR, 'clip10.wav')
        write_wav(out, i16)
        evidence['files']['clip10.wav'] = {'frames': int(i16.shape[1]), 'seconds': i16.shape[1] / SR, 'sampleRate': SR, 'channels': 2, 'peak': pk, 'peakOver32768': pk / 32768}
        with open(os.path.join(EVIDENCE_DIR, 'fixture.json'), 'w', encoding='utf-8') as f:
            json.dump(evidence, f, indent=2)
        print(json.dumps(evidence['files'], indent=1))
        return

    stale = os.path.join(FIX_DIR, 'clip10.wav')          # a leftover from an earlier fallback run
    if os.path.exists(stale):
        os.remove(stale)
    evidence['fixture'] = 'ccmixter-slow-motion-dream'
    mix = load_stereo(evidence['sources']['mix']['path'])
    lead = load_stereo(evidence['sources']['lead_vocal']['path'])
    drums_l = load_stereo(evidence['sources']['drums_left']['path'])
    drums_r = load_stereo(evidence['sources']['drums_right']['path'])
    guitar = load_stereo(evidence['sources']['lead_guitar']['path'])

    # stem[t] <-> mix[t + lag].  Design method first (100 Hz RMS envelopes); when its peak is ambiguous (ratio < 3)
    # try a waveform cross-correlation (the stem is a literal component of the mix); if that is ambiguous too,
    # the window rule falls back to 60 s.
    lag_env, ratio_env = align_envelope(mix, lead)
    lag, ratio, method = lag_env, ratio_env, 'envelope'
    lag_wf, ratio_wf = None, None
    if ratio_env < 3:
        lag_wf, ratio_wf = align_waveform(mix, lead)
        if ratio_wf >= 3:
            lag, ratio, method = lag_wf, ratio_wf, 'waveform'
    evidence['alignment'] = {
        'offsetSeconds': lag / SR, 'offsetSamples': lag, 'peakRatio': ratio, 'method': method,
        'envelope': {'offsetSeconds': lag_env / SR, 'peakRatio': ratio_env, 'method': 'xcorr of 100 Hz RMS envelopes (hop 441), ±0.5 s excluded for the second peak'},
        'waveform': None if lag_wf is None else {'offsetSeconds': lag_wf / SR, 'peakRatio': ratio_wf, 'method': 'xcorr of mono waveforms decimated to 4,410 Hz, refined at 44.1 kHz, ±0.5 s excluded'},
    }

    n25 = 25 * SR
    n20 = 20 * SR
    mix_len = mix.shape[1]
    stem_len = min(lead.shape[1], drums_l.shape[1], drums_r.shape[1], guitar.shape[1])
    # window start s (mix time, 1 s grid) must keep [s, s+25) inside the mix and [s-lag, s-lag+25) inside the stems
    inst_all = drums_l[:, :stem_len] + drums_r[:, :stem_len] + guitar[:, :stem_len]
    candidates = []                                 # (lead energy over 25 s, inst energy over the first 20 s, s)
    for s in range(0, mix_len // SR):
        start = s * SR
        st = start - lag
        if start + n25 > mix_len or st < 0 or st + n25 > stem_len:
            continue
        e_lead = float((lead[:, st:st + n25] ** 2).sum())
        e_inst = float((inst_all[:, st:st + n20] ** 2).sum())
        candidates.append((e_lead, e_inst, s))
    if not candidates:
        raise RuntimeError('no valid 25 s window')
    # the song has vocal-only stretches (drums + guitar silent); the instrumental fixture must not be silent,
    # so windows whose drums+guitar energy is below 5 % of the loudest such window are excluded first
    max_inst = max(c[1] for c in candidates)
    usable = [c for c in candidates if c[1] >= 0.05 * max_inst] or candidates
    if ratio < 3:
        rule = 'fallback-60s'
        s = 60
        if not any(c[2] == s for c in usable):
            s = usable[0][2]
    else:
        rule = 'max-lead-vocal-energy-with-instruments'
        s = max(usable)[2]
    start = s * SR
    st = start - lag
    chosen = next(c for c in candidates if c[2] == s)
    evidence['window'] = {'startSeconds': s, 'startSample': start, 'stemStartSample': st, 'seconds': 25, 'rule': rule,
                          'candidates': len(candidates), 'usable': len(usable),
                          'leadEnergy': chosen[0], 'instEnergy20s': chosen[1], 'maxInstEnergy20s': max_inst,
                          'instThreshold': '>= 5 % of maxInstEnergy20s'}

    clip = mix[:, start:start + n25]
    assert clip.shape == (2, n25)
    i16, pk = to_int16_peak(clip, 32767)
    p25 = os.path.join(FIX_DIR, 'clip25.wav')
    write_wav(p25, i16)
    evidence['files']['clip25.wav'] = {'frames': n25, 'seconds': 25.0, 'sampleRate': SR, 'channels': 2, 'peak': pk, 'peakOver32768': pk / 32768,
                                       'scale': float(32767 / np.abs(clip).max())}

    clip_f = i16.astype(np.float64) / 32768.0        # resample what we actually wrote
    r48 = librosa.resample(clip_f, orig_sr=SR, target_sr=48000, res_type='soxr_hq')
    r48 = r48[:, :1200000]
    assert r48.shape == (2, 1200000), r48.shape
    i48, pk48 = to_int16_peak(r48, 32767)
    p48 = os.path.join(FIX_DIR, 'clip25_48k.wav')
    write_wav(p48, i48, 48000)
    evidence['files']['clip25_48k.wav'] = {'frames': 1200000, 'seconds': 25.0, 'sampleRate': 48000, 'channels': 2, 'peak': pk48, 'peakOver32768': pk48 / 32768}

    inst = drums_l[:, st:st + n20] + drums_r[:, st:st + n20] + guitar[:, st:st + n20]
    assert inst.shape == (2, n20)
    i_inst, pk_inst = to_int16_peak(inst, round(0.9 * 32767))
    pinst = os.path.join(FIX_DIR, 'clip20_inst.wav')
    write_wav(pinst, i_inst)
    evidence['files']['clip20_inst.wav'] = {'frames': n20, 'seconds': 20.0, 'sampleRate': SR, 'channels': 2, 'peak': pk_inst, 'peakOver32768': pk_inst / 32768,
                                            'instrumentalSource': 'ccmixter_stems', 'stems': ['drums_left', 'drums_right', 'lead_guitar']}

    for name in ('clip25.wav', 'clip25_48k.wav', 'clip20_inst.wav'):
        p = os.path.join(FIX_DIR, name)
        info = sf.info(p)
        evidence['files'][name].update({'bytes': os.path.getsize(p), 'sha256': sha256_of(p),
                                        'headerFrames': int(info.frames), 'headerSampleRate': int(info.samplerate),
                                        'headerChannels': int(info.channels), 'subtype': info.subtype})
    evidence['durations'] = {'mixSeconds': mix_len / SR, 'stemSeconds': stem_len / SR}
    with open(os.path.join(EVIDENCE_DIR, 'fixture.json'), 'w', encoding='utf-8') as f:
        json.dump(evidence, f, indent=2)
    print(json.dumps({'alignment': evidence['alignment'], 'window': evidence['window'], 'files': evidence['files']}, indent=1))


if __name__ == '__main__':
    main()
