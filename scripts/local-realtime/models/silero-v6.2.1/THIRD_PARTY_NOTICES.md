# Silero VAD model notice

- Project: [snakers4/silero-vad](https://github.com/snakers4/silero-vad)
- Upstream release: `v6.2.1`
- Upstream commit: `7e30209a3e901f9842f81b225f3e93d8199902b1`
- Resource: `src/silero_vad/data/silero_vad_16k_op15.onnx`
- Size: `1,289,603` bytes
- SHA-256: `7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49`
- License: MIT; the complete upstream text is included in `LICENSE`.
- Modification: none; the ONNX resource is redistributed byte-for-byte.

The optional Python runtime below is not bundled with the application. When a
user explicitly installs the experimental shadow runtime, the application
downloads only the official PyPI wheels whose exact filenames and SHA-256
digests are recorded in `vad-runtime-lock.json`. Each wheel retains its own
package metadata and license files.

| Package | Fixed version | Source | License / notices |
| --- | --- | --- | --- |
| ONNX Runtime | `1.23.2` or `1.27.0`, selected by the audited ABI matrix | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | MIT; [v1.23.2 notices](https://github.com/microsoft/onnxruntime/blob/v1.23.2/ThirdPartyNotices.txt), [v1.27.0 notices](https://github.com/microsoft/onnxruntime/blob/v1.27.0/ThirdPartyNotices.txt) |
| coloredlogs | `15.0.1` | [xolox/python-coloredlogs@15.0.1](https://github.com/xolox/python-coloredlogs/tree/15.0.1) | MIT |
| humanfriendly | `10.0` | [xolox/python-humanfriendly@10.0](https://github.com/xolox/python-humanfriendly/tree/10.0) | MIT |
| FlatBuffers Python runtime | `25.9.23` | [google/flatbuffers@v25.9.23](https://github.com/google/flatbuffers/tree/v25.9.23) | Apache-2.0 |

The installer uses `--no-deps` and an App-owned target so it cannot replace the
Qwen/Whisper environment. NumPy and any other imports required by an ONNX
Runtime wheel must already be present in the selected voice Python; otherwise
the staging inference fails closed and the prior runtime (if any) is retained.
