#!/usr/bin/env python3
"""
证件照工作台 · 本地开发服务器
相比 python -m http.server 的改进：
  1. 禁用缓存（no-store），避免改了 js/css 但浏览器仍用旧版，
     导致出现 "does not provide an export named ..." 这类假故障
  2. 静默 404 噪音（favicon 等）
  3. 端口被占用时自动顺延，并自动打开浏览器
用法：python _serve.py [port]
"""
import http.server
import socketserver
import sys
import os
import socket
import threading
import time
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8848
ROOT = os.path.dirname(os.path.abspath(__file__))


def find_free_port(start, tries=20):
    """从 start 开始找一个可用端口，避免「端口被占用直接崩」"""
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    raise SystemExit('找不到可用端口（%d-%d 都被占用）' % (start, start + tries - 1))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 开发期一律不缓存，保证刷新即最新
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只记录非 2xx，减少刷屏
        msg = fmt % args
        if ' 200 ' in msg or ' 304 ' in msg:
            return
        sys.stderr.write('[serve] %s\n' % msg)


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def open_when_ready(port):
    """等端口真正可连后再开浏览器，避免出现「无法访问」空白页"""
    deadline = time.time() + 8
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            if s.connect_ex(('127.0.0.1', port)) == 0:
                webbrowser.open('http://127.0.0.1:%d/index.html' % port)
                return
        time.sleep(0.2)


if __name__ == '__main__':
    port = find_free_port(PORT)
    if port != PORT:
        print('端口 %d 被占用，改用 %d' % (PORT, port))
    with ReuseServer(('127.0.0.1', port), NoCacheHandler) as httpd:
        url = 'http://127.0.0.1:%d/index.html' % port
        print('证件照工作台已启动: %s' % url)
        print('已禁用缓存，修改文件后刷新即生效。关闭本窗口即停止服务。')
        threading.Thread(target=open_when_ready, args=(port,), daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')

