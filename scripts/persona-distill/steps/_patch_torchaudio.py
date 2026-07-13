"""
Monkey-patch torchaudio.save to use soundfile backend.
torchaudio 2.11+ cu128 requires torchcodec for saving,
but torchcodec DLLs may fail to load on some systems.
This patch ensures demucs can save output WAV files.
"""
import soundfile as sf
import torchaudio


_original_save = torchaudio.save


def _patched_save(uri, src, sample_rate, **kwargs):
    """Use soundfile.write instead of torchaudio.save."""
    import numpy as np
    import os

    path = str(uri)
    # Ensure output directory exists
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    # Convert tensor to numpy
    if hasattr(src, "cpu"):
        data = src.cpu().numpy()
    else:
        data = np.asarray(src)

    # soundfile expects (samples, channels), torchaudio uses (channels, samples)
    if data.ndim == 1:
        # mono
        sf.write(path, data, int(sample_rate))
    elif data.ndim == 2:
        # multi-channel: transpose from (channels, samples) to (samples, channels)
        sf.write(path, data.T, int(sample_rate))
    else:
        raise ValueError(f"Unexpected audio shape: {data.shape}")


torchaudio.save = _patched_save
print("[_patch_torchaudio] torchaudio.save patched to use soundfile backend", flush=True)
