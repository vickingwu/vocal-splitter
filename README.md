# 人声分离

在浏览器内把一首歌分离成「人声」和「伴奏」两条音轨，输出 MP3 / WAV。模型（「标准」为 UVR MDX-Net，「高质量」为 Mel-Band RoFormer）和全部计算都在本机浏览器里运行，没有服务器。

地址：https://vickingwu.github.io/vocal-splitter/

## 使用

1. 打开上面的地址，登录。账号 `MQ`，密码向管理员索取。登录有效期 7 天，之后需重新登录。
2. 拖入或点击选择音频文件（也可以是 mp4 / mov 等视频文件，只取音轨），或在输入框粘贴音频文件的直链后点「读取链接」。
3. 选择模型（默认「标准」；「高质量」仅在满足条件的桌面浏览器上出现，见下），需要时勾选「降噪」（两次推理，耗时约翻倍；「高质量」没有降噪）。
4. 点「开始」。首次使用先下载运行环境（onnxruntime-web 的 .wasm，WebGPU 27 MB / WASM 14 MB），进度行显示 `正在下载运行环境 · 12 MB / 27 MB · 0.3 MB/s · 预计剩余 0:50`；再下载模型，显示 `正在下载模型 · 61 MB / 219 MB · 0.3 MB/s · 预计剩余 8:40`；分离阶段显示 `分离中 17/69 段 · 已用 3:05 · 预计剩余 9:40`。
5. 完成后可直接试听，并点「下载 MP3」或「下载 WAV」。文件名为 `<原文件名>_人声.mp3` / `<原文件名>_伴奏.mp3`（WAV 同理）。

退出：右上角「退出」。

## 模型与运行环境来源

模型文件和运行环境文件（onnxruntime-web 1.31.1 的 `site/vendor/ort/ort-wasm-simd-threaded[.asyncify].wasm` 及其胶水 `.mjs`，WebGPU 28,747,738 + 53,457 字节，WASM 14,848,852 + 24,738 字节）只下载一次，之后存在浏览器里（Cache Storage，不可用时用 IndexedDB）。2026-11-05 起运行环境文件也走下面的下载器（manifest 的 `runtime.<backend>` 一节：文件名、字节数、sha256、`sources`），下载完成后把字节直接交给 onnxruntime-web（`env.wasm.wasmBinary` + blob: URL 的胶水），onnxruntime-web 自己不再发任何网络请求；此前这 28.7 MB 由 onnxruntime-web 内部用一个不可重试、不可续传的 XMLHttpRequest 拉取，在慢链路上失败后页面误报成「GPU 不可用」。下载过程：

- 页面同时向 `site/models/manifest.json` 里该文件的全部 `sources` 各发一个 256 KB 的 Range 请求（4 秒超时），按实测速度排序，从最快的源下载；不可达、无 CORS 头或返回错误的源被排除；4 秒内一个字节都没到的源不排除，排在最后（若 4 秒时所有源都没有字节，再等 4 秒）。站内（GitHub Pages）始终保留为最后的兜底源。
- 来源分两类：`chunks` = 本仓库 `site/models/<id>/part-NN.bin`（每块 ≤ 19,000,000 字节）的镜像，按 git 标签 `models-<manifest 版本>` 固定（jsDelivr 的 fastly.jsdelivr.net / jsdelivr.b-cdn.net 及其镜像 cdn.jsdmirror.com、raw.githubusercontent.com 及其加速 ghfast.top / ghproxy.net）；`whole` = 字节完全相同的原始文件（Hugging Face huggingface.co，sha256 与本仓库一致，`scripts/data/model_sources.json`）。2026-11-05 线上核对后去掉了三类源（`../evidence/sources_live_before_prune.json`、`sources_live_chromium_before_prune.json`）：cdn.jsdelivr.net 与 gcore.jsdelivr.net 对 Range 请求按压缩后的表示作答（Content-Range 总长 ≠ 文件大小、无 Content-Length，cdn.jsdelivr.net 还会在两种表示之间切换，Chromium 里的下载因此中途失败）；hf-mirror.com 的 302 跳转不带 Access-Control-Allow-Origin，浏览器通不过 CORS 检查（curl -L 只看最后一跳所以看不出来）。hf-mirror.com 仍可在浏览器地址栏里直接下载模型文件，然后用「导入模型文件」导入。
- 运行环境文件的来源（`scripts/data/runtime_sources.json`）：站内；按标签固定的 `site/vendor/ort/<文件>` 镜像（raw.githubusercontent.com、ghfast.top、ghproxy.net；14.8 MB 的 WASM 文件另有 cdn.jsdmirror.com 和 fastly.jsdelivr.net 的 gh 端点——jsDelivr 的 GitHub 端点不提供 20 MB 以上的文件，28.7 MB 的 WebGPU 文件不列）；以及 onnxruntime-web@1.31.1 npm 包里字节完全相同的官方副本（sha256 已核对，`../evidence/runtime_sources_probe.json`）：cdn.jsdmirror.com/npm、jsdelivr.b-cdn.net/npm、fastly.jsdelivr.net/npm、cdn.jsdelivr.net/npm、registry.npmmirror.com、unpkg.com。来源的 Range 行为因客户端而异（`../evidence/runtime_sources_probe.json` 为 curl，`../evidence/runtime_sources_browser_probe.json` 为 Chromium 在站点页面里的实测）：Chromium 里站内、raw / ghfast / ghproxy、jsdmirror、fastly.jsdelivr.net 等对 `.wasm` 回答未压缩的 206，可按字节续传；unpkg / npmmirror / b-cdn 忽略 Range（200 整文件）、cdn.jsdelivr.net 时而按 brotli 表示回答——这些源整文件一次下载（出错后重新开始，但已完成的 4 MiB 分段保留）。整文件请求站内返回 gzip（28.7 MB 线上传 7.3 MB）。下载器的每个请求都带 `cache: 'no-store'`：Chromium 会把同一 URL 已缓存的 206 与随后压缩表示不同的整文件应答拼接，拼出的正文被静默截断（`../evidence/runtime_cache_quirk.json`：14.8 MB 的文件只得到 262,144 字节、状态 200）；存储层本身就是缓存，不需要 HTTP 缓存。
- 以 4 MiB 为单位分段下载（并行数按探测到的链路速度决定——各源实测速度之和，且不超过最快源实测速度的 4 倍：< 512 KB/s 时 1 段、< 2 MB/s 时 2 段、否则 4 段），每段下载完立刻写入存储。请求出错或 20 秒没有字节时，已收到的字节保留并写入存储，下一次请求从断点继续（`Range` 从已收字节处开始，不重传；回答带 `Content-Encoding` 或返回 416 的源没有可用的断点，该分段从头重下）；断开前新收到不足 256 KB 的算一次失败，等待时间按这个分段的失败次数取 1 / 2 / 4 / 8 / 16 秒（之后每次 16 秒），同一个源对该分段失败两次就换下一个源，所有源都失败两次算一轮，三轮之后才报 `模型下载失败（已保存 61 MB / 219 MB，刷新后继续）`，运行环境文件对应 `运行环境下载失败（已保存 12 MB / 27 MB，刷新后继续）。`（已保存 = 存储里的字节，含未完成分段的前缀；只有站内一个源时即 6 次连续无进展的尝试、31 秒等待；没有总超时）；断开前已收到 ≥ 256 KB 的不算失败，该分段的等待回到 1 秒、在同一源续传（经常断线但有速度的链路不会被判成死源），但连续第 3 次这样的断开仍记该源一次失败（每次只给一点字节就断的源不会一直占着这个分段）。新分段从哪个源下载（游标）：某源失败两次后换下一个，1 分钟后回到最快的可用源再试（同一源每被换下一次，这个间隔翻倍，最多 16 分钟）。整文件来源一旦不再支持 Range，本次下载不再使用它。
- 刷新、关闭标签页或下载失败都不会丢失已写入存储的分段和前缀，下次点「开始」从缺失的字节继续；刷新那一刻正在传输的分段（最多 4 段 × 4 MiB，其中尚未写入存储的部分）作废重下。不属于当前 manifest 的旧版本缓存在下次加载时清除。
- 每块校验 sha256，整文件再校验一次；不匹配的块丢弃，给这块提供过字节的来源都不再用于这块，换源重下。
- `?sources=<id,id,…>` 可以固定/排序来源（id 见 manifest）；站内源会自动补在末尾。
- 公共加速站点（ghfast、ghproxy、jsdmirror、b-cdn）随时可能失效或被缓存污染：失效的源只是被排除，不影响其他源。增删来源：编辑 `scripts/data/model_sources.json`（模型；`chunkMirrors` 里的 `{tag}` 会替换成标签名；`whole` 必须是 sha256 相同的文件）或 `scripts/data/runtime_sources.json`（运行环境；`chunkMirrors[].backends` 限定该镜像适用的后端，`npm[].url` 里的 `{file}` 替换成文件名），重新执行 `npm run chunk -- --version <新版本> --tier2`，提交并打标签 `models-<新版本>` 推送（镜像 URL 指向这个标签）。只改来源列表、分块不变时可以沿用原版本号和原标签。探测记录在 `../evidence/sources_probe.json`（本机 Node 探测）、`../evidence/sources_live.json`（线上 curl 逐 URL 核对）、`../evidence/sources_live_chromium.json`（线上 Chromium 逐源整文件下载，站内源被强制断开：`node tests/e2e/live_sources.mjs --base <site> --sources all`）和 `../evidence/runtime_sources_probe.json`（运行环境来源：curl 带浏览器 Accept-Encoding 的 HEAD / 1 KB Range，npm 副本整文件 sha256）。
- GPU 相关的错误提示带原因词，如 `GPU 不可用（原因：device lost），高质量模型无法运行。请改用「标准」模型。`；网络原因（XMLHttpRequest / Failed to fetch 等）的初始化失败不再报成 GPU 问题。

## 离线导入模型与运行环境

网络到所有来源都很慢时，可以把模型文件和运行环境文件用别的方式拿到（U 盘、AirDrop、别的机器或网络下载）再导入：

1. 文件：原始模型文件，或本仓库 `site/models/<id>/` 下的 `part-NN.bin`（可以只导入一部分，缺的块会继续下载）；以及运行环境文件。
   - 「标准」：`UVR-MDX-NET-Voc_FT.onnx`（66,762,490 字节）；iOS / 单线程使用的小模型：`UVR_MDXNET_9482.onnx`（29,704,436 字节）。来源：https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models ，或 Hugging Face 上 sha256 相同的副本（`scripts/data/model_sources.json`）。
   - 「高质量」：`duality_student_core_t1100.onnx` + `duality_student_core_t1100.onnx.data`（5,539,495 + 213,244,940 字节）。来源：https://huggingface.co/musetric/mel-band-roformer-duality-student-onnx 。
   - 运行环境（本仓库 `site/vendor/ort/`，即 onnxruntime-web@1.31.1 npm 包 `dist/` 里的同名文件）：WebGPU 用 `ort-wasm-simd-threaded.asyncify.wasm`（28,747,738 字节）+ `ort-wasm-simd-threaded.asyncify.mjs`（53,457 字节）；WASM（iOS、无 GPU 的桌面）用 `ort-wasm-simd-threaded.wasm`（14,848,852 字节）+ `ort-wasm-simd-threaded.mjs`（24,738 字节）。运行方式一行（`运行方式：WebGPU` / `WASM`）说明本机用哪一组。
   - 已经下载过模型的电脑上，`scripts/fetch_models.ps1` 把文件放在仓库的 `models_src\`（不在 git 里）。
2. 登录后点「导入模型文件」，选中文件（可多选）。页面按 manifest 里的分块 sha256 逐块校验（每次只读一块，不会把 213 MB 的文件整体读进内存），匹配的写入与下载相同的存储；结果显示 `已导入：高质量（213 MB）`、`已导入：运行环境（WebGPU，27 MB）` 或 `文件与清单不匹配`。浏览器存储写不进去（隐私模式、配额）时显示 `导入失败：浏览器存储不可用，文件未保存。`，不会误报已导入。
3. 之后点「开始」不再联网下载模型和运行环境（页面本身的 `app.mjs`、`worker.mjs`、70 KB 的 onnxruntime-web 入口仍从站内加载）。

## 5 分钟歌曲的用时（本机实测，`../evidence/long_run_5min.md`）

i5-1245U（12 线程）/ Intel gen-12lp 集显，300 秒 WAV 输入，模型已缓存，含 MP3 编码：

| 路径 | 每段 | 总用时 |
| --- | --- | --- |
| WebGPU「高质量」（38 窗） | 4.3 s | 3:47 |
| WASM 8 线程 · 9482（iPhone 策略 / 单线程以外的小模型路径） | 4.2 s | 5:54 |
| WebGPU「标准」Voc_FT（68 段） | 5.1 s | 6:52 |
| WASM 8 线程 · Voc_FT，无其他负载 | 12.2 s | ≈ 14.6 min |
| WASM 8 线程 · Voc_FT，同机有其他负载 | 18.1 s | 21:34 |
| WASM 1 线程 · Voc_FT（不隔离；现已改为自动使用 9482） | 52.5 s | ≈ 60 min |

模型下载另计：GitHub Pages 从中国大陆常只有几十 KB/s（用户实测 27 KB/s，209 MB 约 2.2 小时），所以才有上面的多来源下载与离线导入。

## 支持范围

- 输入格式：mp3 / wav / m4a / aac / flac / ogg / opus，以及 mp4 / mov / webm / mkv 视频文件（只解码音轨，用于 iPhone 屏幕录制、Mac QuickTime / OBS 录制的歌曲；时长按音轨计）；单声道会复制为双声道，任意采样率重采样到 44.1 kHz。
- 桌面 Chrome / Edge：最长 15 分钟，文件不超过 200 MB。WebGPU 可用时自动使用，否则使用 WebAssembly（多线程需要页面处于跨源隔离状态，首次打开会自动刷新一次；不可用时单线程运行，此时「标准」自动改用较小的 9482 模型，运行方式一行显示「WASM · 1 线程 · 小模型」）。
- iPhone / iPad Safari ≥ 16.4：最长 6 分钟，WebAssembly 使用较小的 9482 模型，MP3 顺序编码；处理期间保持屏幕亮起。
- 「高质量」模型（Mel-Band RoFormer，约 209 MB）仅在支持 WebGPU 且具备 shader-f16 的桌面浏览器上提供；iOS / iPadOS 上不提供。GPU 不可用时该模型无法运行，页面会提示改用「标准」。
- 链接：仅支持直接指向音频文件的 http(s) 直链，不支持平台页面（YouTube、B 站、网易云、QQ 音乐、抖音、Spotify 等）。目标站点未开放跨域访问时无法读取（当前未配置任何代理），请下载到本地后上传。平台页面链接网页版无法解析：网易云（163cn.tv / music.163.com）的免费单曲可用下面的 GitHub Actions 通道；B 站、QQ 音乐从 GitHub 服务器也取不到（412 / 需登录），先下载文件再上传。
- 输出：MP3 320 kbps CBR 44.1 kHz 立体声；WAV 16-bit PCM。

## GitHub Actions 通道

手机上只有一个平台链接、或不想让设备下载模型时，用私有仓库 https://github.com/vickingwu/vocal-splitter-jobs ：在那里新建一个 Issue、标题贴歌曲链接（音频直链，或网易云 163cn.tv / music.163.com 的免费单曲；B 站、QQ 音乐从 GitHub 服务器取不到），或把文件（音频或 mp4 / mov 录屏）上传到 `inbox/`，GitHub 的服务器用本仓库同一套引擎（`scripts/cli_separate.mjs`：onnxruntime-node CPU，模型 UVR MDX-Net Voc_FT，与网页版同一份代码和模型）分离，几分钟后在该次运行页面的 Artifacts 里下载 `人声-<歌名>.mp3` / `伴奏-<歌名>.mp3`（保留 3 天）。提交方式、用时、每月 2,000 分钟与 15 分钟上限、各平台链接的实测可用性见该仓库的 README。本地命令行同款（需要 ffmpeg）：`node scripts/cli_separate.mjs <音频或视频文件> --out out [--wav] [--tier hq] [--json report.json]`，输出 `out/人声-<文件名>.mp3` 与 `out/伴奏-<文件名>.mp3`。

## 运行测试

```powershell
npm install
npm run vendor          # 从 node_modules 复制 onnxruntime-web / lamejs / coi-serviceworker 到 site/vendor
npm test                # 单元测试（tests/unit）
npm run test:parity     # 与 audio-separator 参考输出比对；模型字节取自 site/models/，需要 ../evidence/ref/<modelId>/ 中的参考音轨；随后运行「高质量」模型的门禁测试
```

参考音轨由 `scripts/reference_mdx.ps1` 生成：Python 环境中的 audio-separator 读取 `models_src/` 里的 .onnx（`scripts/fetch_models.ps1` 下载）对 `tests/fixtures/clip25.wav` 分离。参考音轨缺失时该测试跳过并打印原因。

「高质量」模型的门禁测试（`tests/parity/roformer_parity.test.mjs`）把 `site/src/engine/roformer.mjs` 在 onnxruntime-node CPU 上的输出与 `scripts/tier2_reference.py`（numpy + onnxruntime，在 Python 环境里运行，写出 `../evidence/ref_tier2/window.json` 与参考音轨）比对，并在 `tests/fixtures/clip20_inst.wav`（纯伴奏）上检查人声泄漏；结果写入 `../evidence/parity_tier2.json`，`node scripts/tier2_decision.mjs` 据此和 `--tier hq` 的 WebGPU 端到端结果给出 ship / omit 结论。

浏览器端到端测试需要在终端里设置账号和密码（不要写进任何文件）：

```powershell
$env:VS_TEST_USER = 'MQ'
$env:VS_TEST_PASS = '<密码>'
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --retry      # 桌面 WASM；本地服务器自动启动
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend webgpu --cdp http://127.0.0.1:9222   # WebGPU；9222 不可用时回退到无头 Chromium
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend webgpu --tier hq --cdp http://127.0.0.1:9222 --out ../evidence/e2e_chrome9222_hq.json   # 「高质量」模型（记录每个窗口用时，音轨写到 evidence）
npm run e2e:mobile                                                                 # WebKit iPhone 14 模拟
node tests/e2e/e2e.mjs --browser chromium --device "iPhone 14" --backend wasm --base http://127.0.0.1:8010/
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --no-sw                                      # 不隔离 → 1 线程 → 9482 + 「小模型」
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --import                                      # 离线导入 models_src/ 里「标准」模型 (Voc_FT) 的文件 + site/vendor/ort/ 的 WASM 运行环境文件，分离不联网
node tests/e2e/runtime_download.mjs --scenario all                                 # 运行环境文件走下载器：站内 .wasm 被屏蔽 → 全部字节走镜像（路由本地回答）；30 KB/s 限速 + 连接重置 → 按字节续传；下载中站内断开 → `运行环境下载失败（已保存 … 刷新后继续）。` → 刷新后续传；导入 .asyncify.wasm 后 WebGPU 任务零 vendor/ort/*.wasm 请求 → ../evidence/runtime_download_e2e.json
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --model uvr_mdxnet_9482 --dead-source hf-blane187 --sources hf-blane187,hf-seanghay,origin   # 第一个来源不可达 → 探测排除 → 换源
node tests/e2e/download_failure.mjs --label after                                  # 30 KB/s 限速、下载中途连接重置（断点续传）、下载中刷新、站内慢 + 镜像（Playwright 路由本地回答 206 + CORS）→ 全部字节走镜像：断言 → ../evidence/download_failure_repro.json
node tests/e2e/video_input.mjs --base http://127.0.0.1:8010/                       # mp4 视频文件作为输入（tests/fixtures/clip10.mp4）：accept 列表、预探测、解码长度 ≈ 10 s、分离完成、MP3 → ../evidence/e2e_video_input.json
node tests/tools/check_stems.mjs --dir out --base clip25 --ext mp3                 # 校验 cli_separate.mjs 的输出：MP3 帧头 / 时长，解码后与 ../evidence/ref/uvr_mdx_voc_ft/ 参考音轨的 SNR
npm run bench:wasm                                                                 # 桌面 WASM 模型选择基准（Voc_FT 分段用时 / 内存峰值）→ ../evidence/wasm_decision.json
node tests/e2e/proxies.mjs                                                         # 跨域代理可用性探测 → ../evidence/proxies.json
```

本地预览：`npm run serve`（http://127.0.0.1:8010/）。

## 更新模型

1. `powershell -File scripts/fetch_models.ps1 -Tier2`：下载 .onnx 到 `models_src/` 并校验 sha256（`-Tier2` 同时下载「高质量」模型的 `.onnx` + `.onnx.data`）。
2. `npm run chunk -- --version <新版本号> --tier2 [--wasm-standard uvr_mdx_voc_ft|uvr_mdxnet_9482] [--chunk-bytes 19000000] [--tag models-<新版本号>]`：切分为 ≤ 19,000,000 字节的 `site/models/<id>/*.bin`（jsDelivr 只镜像 20 MB 以下的文件）并重写 `site/models/manifest.json`，其中每个模型的 `sources` 来自 `scripts/data/model_sources.json`，镜像 URL 指向标签 `--tag`（默认 `models-<版本号>`）；同时写入 `runtime` 一节（`site/vendor/ort/` 两组文件的字节数和 sha256，来源来自 `scripts/data/runtime_sources.json`）——升级 onnxruntime-web 后先 `npm run vendor` 再执行本步。`--tier2` 写入「高质量」模型与 `tiers.hq`，省略则站点只有「标准」；`--wasm-standard` 决定桌面 WASM 使用的模型，默认 `uvr_mdx_voc_ft`；iOS 和单线程始终使用 `uvr_mdxnet_9482`。
3. `npm test`（校验 manifest 与目录一致）→ commit → `git tag models-<新版本号>` → push 分支和标签（镜像只在标签推送后才能访问）。核对：`scripts/deploy_check.ps1` 只检查站内的 manifest 和分块；镜像用 `?sources=<id>` 打开站点看 `window.__vs.timings().download.used`，或 `node tests/e2e/e2e.mjs --base <站点> --sources <id>`，逐个确认该源真的提供了字节；不再响应的源从 `scripts/data/model_sources.json` 删掉。浏览器端缓存按文件 sha256 存放：内容不变的模型不会重新下载，换了文件才会。

## 修改密码

1. 只在终端里设置新密码：`$env:VS_PASS = '<新密码>'`，然后 `npm run auth:hash`。
2. 把打印出的 `SALT_HEX` / `HASH_HEX` 两行替换进 `site/auth.mjs`。
3. `$env:VS_TEST_PASS = '<新密码>'; npm test`（含明文扫描，密码不得出现在任何文件或提交信息里）→ commit → push。
4. 已登录的设备不受影响；要让所有设备重新登录，同时修改 `site/auth.mjs` 中的 `SESSION_KEY`。

## 回滚

- 回退某次提交：`git revert <sha>` → push，GitHub Actions 会重新部署。
- 下线站点：`gh api -X DELETE repos/vickingwu/vocal-splitter/pages`，或删除仓库。

## 目录

- `site/`：部署到 GitHub Pages 的全部静态文件（`index.html`、`app.mjs`、`worker.mjs`、`src/engine/` 推理引擎、`src/ui/`、`vendor/`、`models/`）。
- `scripts/`：vendor / 模型切分 / 密码哈希 / 部署检查 / 本地服务器 / 命令行分离（`cli_separate.mjs`：任意音视频文件 → ffmpeg → 引擎 → MP3，GitHub Actions 通道所用；`separate_cli.mjs`：WAV 进 WAV 出的早期版本）。
- `tests/`：单元测试、参考比对、Playwright 端到端测试。
- `NOTICE.md`：第三方许可证。
