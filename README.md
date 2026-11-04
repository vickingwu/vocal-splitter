# 人声分离

在浏览器内把一首歌分离成「人声」和「伴奏」两条音轨，输出 MP3 / WAV。模型（「标准」为 UVR MDX-Net，「高质量」为 Mel-Band RoFormer）和全部计算都在本机浏览器里运行，没有服务器。

地址：https://vickingwu.github.io/vocal-splitter/

## 使用

1. 打开上面的地址，登录。账号 `MQ`，密码向管理员索取。
2. 拖入或点击选择音频文件，或在输入框粘贴音频文件的直链后点「读取链接」。
3. 选择模型（默认「标准」；「高质量」仅在满足条件的桌面浏览器上出现，见下），需要时勾选「降噪」（两次推理，耗时约翻倍；「高质量」没有降噪）。
4. 点「开始」。首次使用会下载模型，进度行显示 `正在下载模型 · 61 MB / 219 MB · 0.3 MB/s · 预计剩余 8:40`；分离阶段显示 `分离中 17/69 段 · 已用 3:05 · 预计剩余 9:40`。
5. 完成后可直接试听，并点「下载 MP3」或「下载 WAV」。文件名为 `<原文件名>_人声.mp3` / `<原文件名>_伴奏.mp3`（WAV 同理）。

退出：右上角「退出」。

## 模型来源

模型文件只下载一次，之后存在浏览器里（Cache Storage，不可用时用 IndexedDB）。下载过程：

- 页面同时向 `site/models/manifest.json` 里该模型的全部 `sources` 各发一个 256 KB 的 Range 请求（4 秒超时），按实测速度排序，从最快的源下载；不可达、无 CORS 头或返回错误的源被排除。站内（GitHub Pages）始终保留为最后的兜底源。
- 来源分两类：`chunks` = 本仓库 `site/models/<id>/part-NN.bin`（每块 ≤ 19,000,000 字节）的镜像，按 git 标签 `models-<manifest 版本>` 固定（jsDelivr 及其镜像 jsdmirror / fastly / b-cdn / gcore、raw.githubusercontent.com 及其加速 ghfast.top / ghproxy.net）；`whole` = 字节完全相同的原始文件（Hugging Face：huggingface.co 与 hf-mirror.com，sha256 与本仓库一致，`scripts/data/model_sources.json`）。
- 以 4 MiB 为单位分段下载（最多 4 段并行），每段下载完立刻写入存储。请求出错或 20 秒没有字节时等待 1 / 2 / 4 / 8 / 16 秒后重试，同一个源连续失败两次就换下一个源；没有总超时。刷新、关闭标签页或下载失败都不会丢失已保存的部分，下次点「开始」从缺失的分段继续；失败文案形如 `模型下载失败（已保存 61 MB / 219 MB，刷新后继续）`。
- 每块校验 sha256，整文件再校验一次；不匹配的块丢弃并换源重下。
- `?sources=<id,id,…>` 可以固定/排序来源（id 见 manifest）；站内源会自动补在末尾。
- 公共加速站点（ghfast、ghproxy、jsdmirror、b-cdn、hf-mirror）随时可能失效或被缓存污染：失效的源只是被排除，不影响其他源。增删来源：编辑 `scripts/data/model_sources.json`（`chunkMirrors` 里的 `{tag}` 会替换成标签名；`whole` 必须是 sha256 相同的文件），重新执行 `npm run chunk -- --version <新版本> --tier2`，提交并打标签 `models-<新版本>` 推送（镜像 URL 指向这个标签）。探测记录在 `../evidence/sources_probe.json`。

## 离线导入模型

网络到所有来源都很慢时，可以把模型文件用别的方式拿到（U 盘、AirDrop、别的机器或网络下载）再导入：

1. 文件：原始模型文件，或本仓库 `site/models/<id>/` 下的 `part-NN.bin`（可以只导入一部分，缺的块会继续下载）。
   - 「标准」：`UVR-MDX-NET-Voc_FT.onnx`（66,762,490 字节）；iOS / 单线程使用的小模型：`UVR_MDXNET_9482.onnx`（29,704,436 字节）。来源：https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models ，或 Hugging Face 上 sha256 相同的副本（`scripts/data/model_sources.json`）。
   - 「高质量」：`duality_student_core_t1100.onnx` + `duality_student_core_t1100.onnx.data`（5,539,495 + 213,244,940 字节）。来源：https://huggingface.co/musetric/mel-band-roformer-duality-student-onnx 。
   - 已经下载过模型的电脑上，`scripts/fetch_models.ps1` 把文件放在仓库的 `models_src\`（不在 git 里）。
2. 登录后点「导入模型文件」，选中文件（可多选）。页面按 manifest 里的分块 sha256 逐块校验（每次只读一块，不会把 213 MB 的文件整体读进内存），匹配的写入与下载相同的存储；结果显示 `已导入：高质量（213 MB）` 或 `文件与清单不匹配`。
3. 之后点「开始」不再联网下载模型。

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

- 输入格式：mp3 / wav / m4a / aac / flac / ogg / opus；单声道会复制为双声道，任意采样率重采样到 44.1 kHz。
- 桌面 Chrome / Edge：最长 15 分钟，文件不超过 200 MB。WebGPU 可用时自动使用，否则使用 WebAssembly（多线程需要页面处于跨源隔离状态，首次打开会自动刷新一次；不可用时单线程运行，此时「标准」自动改用较小的 9482 模型，运行方式一行显示「WASM · 1 线程 · 小模型」）。
- iPhone / iPad Safari ≥ 16.4：最长 6 分钟，WebAssembly 使用较小的 9482 模型，MP3 顺序编码；处理期间保持屏幕亮起。
- 「高质量」模型（Mel-Band RoFormer，约 209 MB）仅在支持 WebGPU 且具备 shader-f16 的桌面浏览器上提供；iOS / iPadOS 上不提供。GPU 不可用时该模型无法运行，页面会提示改用「标准」。
- 链接：仅支持直接指向音频文件的 http(s) 直链，不支持平台页面（YouTube、B 站、网易云、QQ 音乐、抖音、Spotify 等）。目标站点未开放跨域访问时无法读取（当前未配置任何代理），请下载到本地后上传。
- 输出：MP3 320 kbps CBR 44.1 kHz 立体声；WAV 16-bit PCM。

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
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --model uvr_mdxnet_9482 --import              # 离线导入 models_src/ 里的文件，分离不联网
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --model uvr_mdxnet_9482 --dead-source hf-blane187 --sources hf-blane187,hf-seanghay,origin   # 第一个来源不可达 → 探测排除 → 换源
node tests/e2e/download_failure.mjs --label after                                  # 30 KB/s 限速、下载中途连接重置、下载中刷新：续传断言 → ../evidence/download_failure_repro.json
npm run bench:wasm                                                                 # 桌面 WASM 模型选择基准（Voc_FT 分段用时 / 内存峰值）→ ../evidence/wasm_decision.json
node tests/e2e/proxies.mjs                                                         # 跨域代理可用性探测 → ../evidence/proxies.json
```

本地预览：`npm run serve`（http://127.0.0.1:8010/）。

## 更新模型

1. `powershell -File scripts/fetch_models.ps1 -Tier2`：下载 .onnx 到 `models_src/` 并校验 sha256（`-Tier2` 同时下载「高质量」模型的 `.onnx` + `.onnx.data`）。
2. `npm run chunk -- --version <新版本号> --tier2 [--wasm-standard uvr_mdx_voc_ft|uvr_mdxnet_9482] [--chunk-bytes 19000000] [--tag models-<新版本号>]`：切分为 ≤ 19,000,000 字节的 `site/models/<id>/*.bin`（jsDelivr 只镜像 20 MB 以下的文件）并重写 `site/models/manifest.json`，其中每个模型的 `sources` 来自 `scripts/data/model_sources.json`，镜像 URL 指向标签 `--tag`（默认 `models-<版本号>`）。`--tier2` 写入「高质量」模型与 `tiers.hq`，省略则站点只有「标准」；`--wasm-standard` 决定桌面 WASM 使用的模型，默认 `uvr_mdx_voc_ft`；iOS 和单线程始终使用 `uvr_mdxnet_9482`。
3. `npm test`（校验 manifest 与目录一致）→ commit → `git tag models-<新版本号>` → push 分支和标签（镜像只在标签推送后才能访问；`scripts/deploy_check.ps1` 之后逐个核对）。浏览器端缓存按文件 sha256 存放：内容不变的模型不会重新下载，换了文件才会。

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
- `scripts/`：vendor / 模型切分 / 密码哈希 / 部署检查 / 本地服务器 / 命令行分离。
- `tests/`：单元测试、参考比对、Playwright 端到端测试。
- `NOTICE.md`：第三方许可证。
