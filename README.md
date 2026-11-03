# 人声分离

在浏览器内把一首歌分离成「人声」和「伴奏」两条音轨，输出 MP3 / WAV。模型（UVR MDX-Net）和全部计算都在本机浏览器里运行，没有服务器。

地址：https://vickingwu.github.io/vocal-splitter/

## 使用

1. 打开上面的地址，登录。账号 `MQ`，密码向管理员索取。
2. 拖入或点击选择音频文件，或在输入框粘贴音频文件的直链后点「读取链接」。
3. 选择模型（默认「标准」），需要时勾选「降噪」（两次推理，耗时约翻倍）。
4. 点「开始」。进度行显示阶段 / 分段 / 秒数。
5. 完成后可直接试听，并点「下载 MP3」或「下载 WAV」。文件名为 `<原文件名>_人声.mp3` / `<原文件名>_伴奏.mp3`（WAV 同理）。

退出：右上角「退出」。

## 支持范围

- 输入格式：mp3 / wav / m4a / aac / flac / ogg / opus；单声道会复制为双声道，任意采样率重采样到 44.1 kHz。
- 桌面 Chrome / Edge：最长 15 分钟，文件不超过 200 MB。WebGPU 可用时自动使用，否则使用 WebAssembly（多线程需要页面处于跨源隔离状态，首次打开会自动刷新一次；不可用时单线程运行并在进度行标出）。
- iPhone / iPad Safari ≥ 16.4：最长 6 分钟，WebAssembly 使用较小的 9482 模型，MP3 顺序编码；处理期间保持屏幕亮起。
- iOS / iPadOS 上不提供「高质量」模型。
- 链接：仅支持直接指向音频文件的 http(s) 直链，不支持平台页面（YouTube、B 站、网易云、QQ 音乐、抖音、Spotify 等）。目标站点未开放跨域访问时无法读取（当前未配置任何代理），请下载到本地后上传。
- 输出：MP3 320 kbps CBR 44.1 kHz 立体声；WAV 16-bit PCM。

## 运行测试

```powershell
npm install
npm run vendor          # 从 node_modules 复制 onnxruntime-web / lamejs / coi-serviceworker 到 site/vendor
npm test                # 单元测试（tests/unit）
npm run test:parity     # 与 audio-separator 参考输出比对；模型字节取自 site/models/，需要 ../evidence/ref/<modelId>/ 中的参考音轨
```

参考音轨由 `scripts/reference_mdx.ps1` 生成：Python 环境中的 audio-separator 读取 `models_src/` 里的 .onnx（`scripts/fetch_models.ps1` 下载）对 `tests/fixtures/clip25.wav` 分离。参考音轨缺失时该测试跳过并打印原因。

浏览器端到端测试需要在终端里设置账号和密码（不要写进任何文件）：

```powershell
$env:VS_TEST_USER = 'MQ'
$env:VS_TEST_PASS = '<密码>'
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm --retry      # 桌面 WASM；本地服务器自动启动
node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend webgpu --cdp http://127.0.0.1:9222   # WebGPU；9222 不可用时回退到无头 Chromium
npm run e2e:mobile                                                                 # WebKit iPhone 14 模拟
node tests/e2e/e2e.mjs --browser chromium --device "iPhone 14" --backend wasm --base http://127.0.0.1:8010/
npm run bench:wasm                                                                 # 桌面 WASM 模型选择基准（Voc_FT 分段用时 / 内存峰值）→ ../evidence/wasm_decision.json
node tests/e2e/proxies.mjs                                                         # 跨域代理可用性探测 → ../evidence/proxies.json
```

本地预览：`npm run serve`（http://127.0.0.1:8010/）。

## 更新模型

1. `powershell -File scripts/fetch_models.ps1`：下载 .onnx 到 `models_src/` 并校验 sha256。
2. `npm run chunk -- --version <新版本号> [--wasm-standard uvr_mdx_voc_ft|uvr_mdxnet_9482]`：切分为 ≤ 45,000,000 字节的 `site/models/<id>/part-NN.bin` 并重写 `site/models/manifest.json`（`--wasm-standard` 决定桌面 WASM 使用的模型，默认 `uvr_mdx_voc_ft`；iOS 始终使用 `uvr_mdxnet_9482`）。
3. `npm test`（校验 manifest 与目录一致）→ commit → push。新的版本号会让浏览器端旧缓存失效，下次打开时重新下载。

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
