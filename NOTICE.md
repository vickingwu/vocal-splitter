# 第三方许可证（NOTICE）

本仓库自身代码：MIT（见 `LICENSE`）。以下第三方文件随站点一起分发或用于测试，各自保留原许可证。

## 运行时随站点分发的文件

| 组件 | 版本 | 许可证 | 位置 | 来源 |
| --- | --- | --- | --- | --- |
| onnxruntime-web（Microsoft） | 1.31.1 | MIT | `site/vendor/ort/`（`ort.wasm.min.mjs`、`ort.webgpu.min.mjs`、`ort-wasm-simd-threaded.*`、`LICENSE`） | https://github.com/microsoft/onnxruntime · npm `onnxruntime-web` |
| lamejs（Alex Zhukov） | 1.2.1 | **LGPL-3.0** | `site/vendor/lamejs/lame.min.js`（未修改，作为独立文件分发，由 `site/mp3-worker.js` 通过 `importScripts` 加载；可替换）、`site/vendor/lamejs/LICENSE` | https://github.com/zhuker/lamejs · 基于 LAME https://lame.sourceforge.io/ |
| coi-serviceworker（Guido Zuidhof） | 0.1.7 | MIT | `site/coi-serviceworker.min.js` | https://github.com/gzuidhof/coi-serviceworker |
| UVR MDX-Net 模型权重 `UVR-MDX-NET-Voc_FT.onnx`、`UVR_MDXNET_9482.onnx`（Ultimate Vocal Remover，Anjok07 等） | — | MIT | `site/models/uvr_mdx_voc_ft/part-NN.bin`、`site/models/uvr_mdxnet_9482/part-NN.bin`（按字节切分，sha256 见 `site/models/manifest.json`） | https://github.com/Anjok07/ultimatevocalremovergui · 文件：https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/ |
| Mel-Band RoFormer duality student ONNX 导出 `duality_student_core_t1100.onnx` + `.onnx.data`（musetric；蒸馏自 Aname 的 Mel-Band RoFormer Duality，架构见 arXiv:2310.01809） | 2026-11 | Apache-2.0 | `site/models/melroformer_duality_student/core.part-00.bin`、`data.part-00..04.bin`（按字节切分，sha256 见 `site/models/manifest.json`）；主机侧 STFT / 分段 / 掩码应用 / 叠加规则按 musetric `packages/ai` 与 `server/src/unit_plan.rs` 实现于 `site/src/engine/roformer.mjs` | https://huggingface.co/musetric/mel-band-roformer-duality-student-onnx · https://github.com/musetric/musetric |
| wasm-feature-detect 的 SIMD 探测模块（30 字节 wasm 字节序列） | — | MIT | `site/src/ui/caps.mjs` 中的 `SIMD_PROBE` 常量 | https://github.com/GoogleChromeLabs/wasm-feature-detect |

模型的 n_fft / dim_f / dim_t / compensate 参数表来自 UVR / audio-separator 的 `model_data.json`（MIT），见 `scripts/data/mdx_model_data.json`。

## 测试素材

| 素材 | 许可证 | 文件 | 来源 |
| --- | --- | --- | --- |
| 《Slow Motion Dream》，Steven M Bryant（stevieb357） | **CC BY 3.0** | `tests/fixtures/clip25.wav`、`tests/fixtures/clip25_48k.wav`（混音的 25 秒片段，44.1 kHz / 48 kHz）；`tests/fixtures/clip20_inst.wav`（Drums Left + Drums Right + Lead Guitar 分轨叠加的 20 秒片段）；`tests/fixtures/golden/` 由 clip25 派生 | https://ccmixter.org/files/stevieb357/34740 |

## 开发期依赖（不随站点分发）

- python-audio-separator（MIT，https://github.com/nomadkaraoke/python-audio-separator）：生成参考分离结果，供 `tests/parity` 比对；本仓库的推理引擎按其 `mdx_separator.py` 的处理流程实现。
- onnxruntime-node 1.31.1（MIT）、Playwright 1.64.1（Apache-2.0）：仅用于 Node 端测试与浏览器端到端测试。
