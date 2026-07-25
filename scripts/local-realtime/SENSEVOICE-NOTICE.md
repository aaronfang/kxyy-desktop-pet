# SenseVoice optional runtime notices

This optional runtime uses `sherpa-onnx` 1.13.4 (Apache-2.0) and its bundled
ONNX Runtime. The converted SenseVoiceSmall model remains subject to the
FunASR Model Open Source License Agreement 1.1 referenced by the model
archive's `LICENSE` file. Installation must retain `LICENSE`, `README.md`, the
SenseVoiceSmall model name, source attribution, and the wheel's packaged
license. Model files are downloaded only after an explicit optional-runtime
installation action; they are not part of the application bundle.

Sources:

- https://github.com/k2-fsa/sherpa-onnx (Apache-2.0 runtime)
- https://github.com/FunAudioLLM/SenseVoice (MIT implementation)
- https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE (model weights)
- https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models (converted model)

The macOS wheels declare broad platform tags, while the bundled ONNX Runtime
binary may require a newer macOS release. Every supported application target
must therefore pass a real install-and-inference smoke test before release.
