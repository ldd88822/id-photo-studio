# 证件照工作台

一键制作标准证件照：上传 → 自动抠图 → 选规格 → 换底色 → 预览微调 → 下载 / 排版打印。

纯前端应用，**照片不上传服务器，全部在本地浏览器处理**。

## 功能

| 模块 | 说明 |
| --- | --- |
| 自动抠图 | MediaPipe 人像分割（本地模型），失败自动降级为纯色背景抠图 |
| 底色 | 白 / 蓝 / 红 / 渐变蓝 / 渐变红 / 深蓝 / 浅蓝 / 灰，支持自定义颜色与渐变、透明 PNG |
| 规格 | 一寸 / 二寸 / 小二寸 / 大一寸 / 身份证 / 护照 / 港澳通行证 / 驾驶证 / 美·日·申根等签证 / 考试报名，共 30+ 种；支持自定义毫米尺寸与 300/600 DPI |
| 构图 | 人脸检测自动构图（头顶留白 7.5%、头高占 72%，符合证件照标准），参考线辅助，拖拽 / 滚轮 / 双指缩放微调 |
| 精修 | 边缘羽化、去白边、亮度 / 对比度、边缘修补笔（擦除背景残留 / 恢复人物） |
| 导出 | 单张 PNG / JPG；6寸 / 5寸 / A4 相纸排版（自动计算张数 + 裁切虚线）；一键下载白 / 蓝 / 红三张 |
| 适配 | 电脑（鼠标 + 滚轮）与手机（触屏 + 双指缩放）均可用 |

## 运行

**推荐**：双击 `启动证件照工作台.bat`。会自动起服务并打开浏览器，
端口被占用时自动顺延。**关闭那个黑窗口即停止服务** —— 想一直用就别关。

手动起服务：

```bash
python _serve.py 8848
# 打开 http://127.0.0.1:8848/index.html
```

> 服务是前台进程，绑在启动它的那个窗口上。窗口关了、或由 AI 会话代起的进程
> 随会话结束，服务就停了 —— 页面报「无法访问此网站」不是代码问题，重开即可。

> 不要在开发时用 `python -m http.server`：它只发 `Last-Modified`，
> 浏览器会启发式缓存 JS，改了模块导出后页面仍跑旧版，报
> `does not provide an export named ...`，看起来像功能坏了。

> 必须通过 http:// 访问（不能直接双击 index.html），因为浏览器不允许 file:// 加载 wasm 模型。

## 弱网说明

模型 wasm 有 9.4 MB（GitHub Pages 自动 gzip 后约 2.9 MB）。国内访问 GitHub Pages
实测约 43–77 KB/s，**首次打开需等待 1–2 分钟**，界面会实时显示下载百分比与速率。
下载完成后由浏览器缓存，刷新不再重复下载。

## 测试

**一键跑全部**（自动解析 node 路径，避免版本目录漂移导致找不到 node）：

```bash
bash _run_tests.sh
```

手动分别跑：

```bash
NODE=/c/Users/$USER/.workbuddy/binaries/node/versions/$(cat ~/.workbuddy/binaries/node/versions/current)/node.exe

"$NODE" _test.mjs          # 几何变换 / 参数 / 历史栈，63 项
"$NODE" _test_pixel.mjs    # 像素级渲染，10 项
"$NODE" _e2e/run.mjs       # 端到端（需先起本地服务器），73 项
```

合计 146 项。E2E 依赖的 playwright 模块在
`~/.workbuddy/binaries/node/workspace/node_modules/playwright`，脚本里用绝对路径引入。

可用环境变量覆盖端到端地址：`BASE=http://127.0.0.1:8899 bash _run_tests.sh`。

> `versions/current` 是一个**存版本号的文本文件**，不是目录软链 ——
> 拼路径前要先 `cat` 出来，别直接写 `current/node.exe`。

## 目录结构

```
index.html        页面结构
_serve.py         本地开发服务器（强制禁用缓存）
assets/app.css    样式（深色 UI，响应式）
js/specs.js       规格库 / 底色预设 / 相纸
js/matting.js     抠图引擎（分割 + 人脸检测 + 纯色降级 + alpha 后处理 + 加载进度）
js/transform.js   几何变换引擎（矩阵链）
js/angle.js       角度调整控制器（滑杆 / 拖拽 / 撤销重做）
js/app.js         主逻辑（渲染 / 交互 / 导出）
vendor/           本地化的模型与 wasm 运行时（无外网依赖）
docs/             角度调整方案（v1.4）
_e2e/             端到端测试与可视化验证脚本
```

## 技术

- MediaPipe Tasks Vision 0.10.14：`selfie_segmenter.tflite`（人像分割）、`blaze_face_short_range.tflite`（人脸定位）
- Canvas 2D 渲染，输出为标准 300dpi 印刷级像素尺寸
