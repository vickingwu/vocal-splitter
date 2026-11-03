"""scripts/dump_stft_golden.py — audio-separator's STFT of mixture chunk 0 of clip25.wav (design §16.A, mdx-pack).

Run inside the venv:  venv\\Scripts\\python.exe scripts\\dump_stft_golden.py [--model uvr_mdx_voc_ft]
Replicates mdx_separator.py exactly for chunk 0: librosa.load(mono=False, sr=44100) -> spec_utils.normalize(max_peak=0.9)
-> mixture = [zeros(trim), mix, zeros(pad)] -> chunk [0, chunk_size) -> uvr_lib_v5.stft.STFT(...) -> spek[:, :, :3, :] *= 0.
Writes tests/fixtures/golden/stft_chunk0_<modelId>.bin  (4 ch x 64 bins x 16 frames float32 LE, order ch,bin,frame = 16,384 B)
   and tests/fixtures/golden/stft_chunk0_<modelId>.json { modelId, nFft, dimF, hop, bins, frames, layout, inputScale, ... }.
"""
import json
import logging
import os
import sys

import numpy as np
import librosa
import torch
from audio_separator.separator.uvr_lib_v5 import spec_utils
from audio_separator.separator.uvr_lib_v5.stft import STFT

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BINS, FRAMES = 64, 16


def main():
    model_id = 'uvr_mdx_voc_ft'
    if '--model' in sys.argv:
        model_id = sys.argv[sys.argv.index('--model') + 1]
    with open(os.path.join(REPO, 'site', 'models', 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    p = manifest['models'][model_id]['params']
    n_fft, hop, dim_f, dim_t = int(p['nFft']), int(p['hop']), int(p['dimF']), int(p['dimT'])
    trim = n_fft // 2
    chunk_size = hop * (dim_t - 1)
    gen_size = chunk_size - 2 * trim
    normalization = float(p['inputPeak'])

    fixture = os.path.join(REPO, 'tests', 'fixtures', 'clip25.wav')
    mix, sr = librosa.load(fixture, mono=False, sr=44100)            # float32 (2, n), PCM16 -> x/32768
    assert sr == 44100 and mix.ndim == 2 and mix.shape[0] == 2, mix.shape
    peak = float(np.abs(mix).max())
    mix = spec_utils.normalize(wave=mix, max_peak=normalization, min_peak=None)   # in place, float32
    input_scale = float(normalization / peak) if peak > normalization else 1.0

    pad = gen_size + trim - (mix.shape[-1] % gen_size)
    mixture = np.concatenate((np.zeros((2, trim), dtype='float32'), mix, np.zeros((2, pad), dtype='float32')), 1)
    assert mixture.shape[-1] >= chunk_size
    mix_part_ = mixture[:, 0:chunk_size]
    mix_part = torch.tensor([mix_part_], dtype=torch.float32)        # [1, 2, chunk_size]

    stft = STFT(logging.getLogger('golden'), n_fft, hop, dim_f, torch.device('cpu'))
    with torch.no_grad():
        spek = stft(mix_part)                                          # [1, 4, dim_f, dim_t]
        spek[:, :, :3, :] *= 0
    assert tuple(spek.shape) == (1, 4, dim_f, dim_t), tuple(spek.shape)
    window = spek[0, :, :BINS, :FRAMES].contiguous().cpu().numpy().astype('<f4')   # ch, bin, frame
    assert window.shape == (4, BINS, FRAMES)
    data = window.tobytes(order='C')
    assert len(data) == 4 * BINS * FRAMES * 4 == 16384

    out_dir = os.path.join(REPO, 'tests', 'fixtures', 'golden')
    os.makedirs(out_dir, exist_ok=True)
    bin_path = os.path.join(out_dir, f'stft_chunk0_{model_id}.bin')
    with open(bin_path, 'wb') as f:
        f.write(data)
    meta = {
        'modelId': model_id, 'nFft': n_fft, 'dimF': dim_f, 'dimT': dim_t, 'hop': hop,
        'bins': BINS, 'frames': FRAMES, 'layout': 'ch,bin,frame', 'channels': ['L_re', 'L_im', 'R_re', 'R_im'],
        'dtype': 'float32le', 'bytes': len(data),
        'inputScale': input_scale, 'fixturePeak': peak, 'normalization': normalization,
        'trim': trim, 'chunkSize': chunk_size, 'genSize': gen_size, 'pad': int(pad), 'mixtureLen': int(mixture.shape[-1]),
        'zeroLowBins': 3, 'chunkIndex': 0, 'chunkStart': 0,
        'maxAbs': float(np.abs(window).max()),
        'torch': torch.__version__, 'librosa': librosa.__version__, 'numpy': np.__version__,
    }
    with open(os.path.join(out_dir, f'stft_chunk0_{model_id}.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)
        f.write('\n')
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()
