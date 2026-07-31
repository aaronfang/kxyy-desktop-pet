# Qwen3-TTS 元元单人微调

本目录只保存可复现脚本；授权音频、转写、codec、模型权重和评测音频均位于 `.gitignore` 覆盖的本地目录，不得提交或上传。

## 固定条件

- 官方源码：Qwen3-TTS `022e286b98fbec7e1e916cb940cdf532cd9f488e`
- 模型：`Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- 训练：全参数、bf16、SDPA、batch 1、gradient accumulation 4、最多 3 轮
- speaker：`yuanyuan`（custom id 3000）
- 数据门槛：CAM++ `>=0.55`；最终 469 条/3208.46 秒，train/validation 按直播来源和日期隔离

## 本地流水线

```powershell
# 1. 转写、声纹筛选、定稿与验证
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\transcribe_candidates.py --backend faster --model small --sources 21 --seconds-per-source 1800 --target-candidate-seconds 14400 --reset
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\score_candidates.py --device cuda --reset
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\finalize_dataset.py --train-seconds 2700 --validation-seconds 580
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\verify_dataset.py --manifest scripts\qwen3-finetune\work\manifest.json --self-test-date-leak

# 2. codec 与 SFT（模型先下载到 work/models）
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\prepare_codes.py --tokenizer-model scripts\qwen3-finetune\work\models\Qwen3-TTS-12Hz-0.6B-Base\speech_tokenizer --batch-size 4 --reset
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\train_sft.py --init-model-path scripts\qwen3-finetune\work\models\Qwen3-TTS-12Hz-0.6B-Base --num-epochs 1 --lr 2e-6 --speaker-name yuanyuan --output-model-path scripts\qwen3-finetune\output-lr2e6
```

训练入口补上了官方 0.6B SFT 漏掉的 `talker.text_projection`，启用 gradient checkpointing，并在每 64 micro-step 生成可推理中间 checkpoint。

## 2026-07-30 结果

- `2e-5` 三轮发生严重生成退化：epoch 2 声纹均值 0.185、CER 4.142、6/12 触及时长上限。
- `2e-6` 最佳候选是 `output-lr2e6/intermediate/checkpoint-epoch-64`：声纹均值 0.649（1.7B Base 基线 0.670），仅 5/12 提升；CER 0.050（基线 0.080），0 条触顶。
- 硬验收要求声纹均值 `+0.03`、至少 8/12 提升、CER 恶化不超过 0.02；因此本轮 **未通过音色验收，不得设为默认模型**。
- faster custom streaming 技术验收通过：3 chunks，TTFA 0.709 秒，RTF 0.35。

如需本地人工试听，可临时把设置 `qwen3ModelDir` 指向上述 64-step checkpoint。后端会从 `config.json` 自动选择唯一 `yuanyuan` speaker，并走 `generate_custom_voice_streaming`；清空该设置即可回到 1.7B Base 零样本克隆。

## 无人工挑选的 1.7B 参考音优化

这条路线从全部候选建立无参考音主播中心，自动淘汰参考音，再用冻结的 12 条文本复验。只有完整门槛通过，`promote_reference.py` 才会原子写入被 `.gitignore` 覆盖的 `work/active-reference.json`；Windows faster 后端会校验音频路径和 SHA-256 后启用。设置中的 `localRefWav` 始终优先。

```powershell
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\select_references.py --reset
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\run_reference_tournament.py --reset
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\score_reference_tournament.py --reset
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\run_reference_validation.py --reset
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\score_reference_validation.py
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\promote_reference.py
```

2026-07-30 自动赢家为 `utt_9627ec90ea95`：12 条 CAM++ 中心相似度 0.474 → 0.665（+0.191，12/12 提升），CER +0.0117，风格距离 0.722 → 0.266，无触顶/重复。1.7B clone 真流式为 3 chunks、TTFA 0.788 秒、RTF 0.378。该路线已过门槛，因此没有继续训练表现更差且不流式友好的 1.7B LoRA。

后续主观复核否定了上述“风格距离”：它把尾静音和直播素材的多数低声快语片段当成目标，不能代表轻重缓急。慢速动态参考、响度归一、时间拉伸和多参考拼接已自动复验，均因音色逐句覆盖、CER 或句调门槛失败，未替换 active reference。参考音只能稳定改善音色；语气下一步必须进入高表现力金标集训练或支持指令韵律的后端评估。

## 75 条样例试听与手动替换

评分完成后启动本地画廊：

```powershell
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\reference_gallery.py --open
```

画廊只监听 `127.0.0.1`，展示首轮 75 条训练外探针；每条有 CAM++、CER、SNR、RMS、时长和组门槛结果，可直接播放。点击“用此参考音”会原子写入 `work/active-reference.json`，后端在下一句合成前按 SHA-256 自动热刷新，不需要重启语音服务。显式设置 `localRefWav` 仍然优先。

普通朗读与实时通话共用播放层 `voiceVolume`；本机试听配置已调到现有上限 `200%`，不修改生成波形。

## 发布音色清单

发布资源位于 `scripts/local-realtime/assets/kxyy-yuanyuan/voices.json`：只收录 5 个通过 75 条训练外样例自动评分的最高参考音（最高 CAM++ 均值 `0.705453`）和现有最早 `ref.wav/ref.txt` 基线。设置页的 `localVoicePreset` 只保存这 6 个 allow-list id；Python 每句合成前校验目录、文案长度和 SHA-256 后热加载，未通过校验会保留当前音色。75 条生成样例、其余候选、模型和报告继续留在 `.gitignore` 覆盖的本地目录，不能提交或上传。语气表现力微调按当前验收结论延期。

## 2026-07-31 声纹尾部稳定性实验

偶发整句换人的验收不能只看 12 条单次生成均值。以下工具按 Windows
生产路径重复生成同一文本，并统计主播中心 `min/p10/std` 与同句两两声纹一致性；
音频和报告仍只写入被忽略的本地目录。

```powershell
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\run_voice_stability.py --model scripts\qwen3-finetune\work\models\Qwen3-TTS-12Hz-1.7B-Base --mode clone --reference-manifest scripts\qwen3-finetune\work\active-reference.json --run-name stability-current-clone --repeats 5 --limit 4 --reset
& '.\scripts\persona-distill\.venv-distill\Scripts\python.exe' scripts\qwen3-finetune\score_voice_stability.py --input current-clone=scripts\qwen3-finetune\reports\stability-current-clone.jsonl --run-name stability-current-clone
```

旧 0.6B step-64 在 4 条 x 5 次生产流式 A/B 中未通过：相对当前零样本，主播中心
均值 `0.681 -> 0.473`、最低值 `0.614 -> 0.378`，同句最差一致性
`0.657 -> 0.654`，因此不复活旧 checkpoint。

1.7B 实验改用 LoRA，只覆盖主 talker 的注意力投影，并将 LoRA 合并成 faster
runtime 可直接加载的 custom checkpoint。训练时累计多条 Qwen speaker embedding，
不再像旧全量 SFT 一样用随机第一条音频注册 `yuanyuan`。实验 venv 固定安装
`peft==0.20.0`：

```powershell
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' -m pip install peft==0.20.0
& '.\scripts\local-realtime\.venv-qwen3\Scripts\python.exe' scripts\qwen3-finetune\train_lora.py --init-model-path scripts\qwen3-finetune\work\models\Qwen3-TTS-12Hz-1.7B-Base --output-model-path scripts\qwen3-finetune\output-lora17-smoke --max-micro-steps 1 --smoke-longest
```

单步冒烟与 faster 流式加载均通过（峰值显存 `4.239 GiB`，TTFA `0.710s`，RTF `0.353`）。
但 32-step 候选的主播中心均值仅 `0.454`，完整 1 epoch 候选进一步退化到 `0.196`，
并出现 `CER 0.838`、5/20 条时长护栏触发；两者都没有达到当前零样本的 `0.681` 均值、
`0.614` 最低值。因此这条 1.7B LoRA/custom-voice 路线本轮不启用，保留 checkpoint
仅供离线分析，不得写入设置或发布资源。
