"""
sitecustomize.py – auto-imported at Python startup.
Patches torchaudio.save to use soundfile, avoiding torchcodec DLL issues.
"""
import soundfile as sf
import numpy as np
import os


def _patched_torchaudio_save(uri, src, sample_rate, **kwargs):
    path = str(uri)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if hasattr(src, "cpu"):
        data = src.cpu().numpy()
    else:
        data = np.asarray(src)
    if data.ndim == 2:
        data = data.T  # (channels, samples) → (samples, channels)
    sf.write(path, data, int(sample_rate))


try:
    import torchaudio
    torchaudio.save = _patched_torchaudio_save
except ImportError:
    pass
