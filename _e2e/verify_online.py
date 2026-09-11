"""验证 GitHub Pages 线上版本是否已是 v1.4。带轮询等待构建完成。"""
import urllib.request
import time
import sys

BASE = 'https://ldd88822.github.io/id-photo-studio/'

# 每个文件里必须出现的特征串（证明是新版）：(路径, 特征串, 说明)
CHECKS = [
    ('index.html', 'id="loadRetry"', '加载遮罩重试按钮'),
    ('js/app.js', 'bindModelRetry', '重试逻辑绑定'),
    ('js/app.js', "retrying ? '模型已就绪", '重试文案分支'),
    ('js/matting.js', 'setProgressHandler', '进度回调导出'),
    ('js/matting.js', 'probeWasmSpeed', 'wasm 速率探测'),
    ('js/matting.js', 'initPromise = null', '坏 Promise 不缓存'),
    ('js/matting.js', 'WASM_DECODED_SIZE', 'wasm 解压体积常量'),
    ('js/transform.js', 'mirrorX', '镜像矩阵'),
    ('js/angle.js', 'ANGLE_FLAGS', '布尔开关表'),
    ('js/angle.js', '-90, 90', '拖拽量程钳制 ±90'),
    ('js/transform.js', "label: '自由旋转', unit: '°', min: -90, max: 90", '自由旋转 ±90° 参数定义'),
]

# 必须【不存在】的（证明旧参数确实下架）：(路径, 特征串, 说明)
ABSENT = [
    ('index.html', 'data-m="persp"', '快捷模式已无「透视」'),
    ('js/transform.js', "key: 'perspX'", '参数 perspX 已下架'),
    ('js/transform.js', "key: 'yaw'", '参数 yaw 已下架'),
]

UA = {'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'}


def fetch(path):
    url = BASE + path
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', errors='replace')


def probe():
    results = []
    for path, needle, label in CHECKS:
        try:
            body = fetch(path)
            results.append((label, needle in body, path))
        except Exception as e:
            results.append((label, False, '%s (%s)' % (path, type(e).__name__)))
    for path, needle, label in ABSENT:
        try:
            body = fetch(path)
            results.append((label, needle not in body, path))
        except Exception as e:
            results.append((label, False, '%s (%s)' % (path, type(e).__name__)))
    return results


deadline = time.time() + 240
attempt = 0
while True:
    attempt += 1
    res = probe()
    ok = sum(1 for _, hit, _ in res if hit)
    print('第 %d 次探测: %d/%d 项命中' % (attempt, ok, len(res)))
    if ok == len(res):
        print('\n✅ 线上已是 v1.4')
        for label, hit, _ in res:
            print('  ✓ %s' % label)
        sys.exit(0)
    if time.time() > deadline:
        print('\n⚠️ 等待超时，未全部命中：')
        for label, hit, extra in res:
            print('  %s %s  [%s]' % ('✓' if hit else '✗', label, extra))
        sys.exit(1)
    time.sleep(15)
