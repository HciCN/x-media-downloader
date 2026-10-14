#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
X-Media-Downloader - 安卓局域网无线远程流媒体服务器
为安卓手机/平板提供无线访问、全屏推文浏览与视频无卡顿 Range 拖拽串流播放
纯 Python 标准库编写，零依赖，开箱即用
"""

import sys
import os
import shutil

# 彻底禁用 Python 字节码缓存生成，避免生成 __pycache__ 导致 Chrome 扩展加载报错
sys.dont_write_bytecode = True

# 启动时自动检查并清除可能残留的 __pycache__ 目录
_curr_dir = os.path.dirname(os.path.abspath(__file__))
_pycache_dir = os.path.join(_curr_dir, '__pycache__')
if os.path.exists(_pycache_dir):
    try:
        shutil.rmtree(_pycache_dir, ignore_errors=True)
    except Exception:
        pass

import socket
import re
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8080

def get_lan_ip():
    """自动获取电脑在局域网（Wi-Fi / 有线网）中的真实 IPv4 地址"""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 连接一个非保留公网地址（不发送真实报文），快速获取出口网卡 IP
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return '127.0.0.1'
    finally:
        if s:
            s.close()

class VideoStreamingHTTPRequestHandler(SimpleHTTPRequestHandler):
    """
    支持 HTTP 206 Partial Content (Range 请求) 的流媒体处理器
    安卓 Chrome / 系统播放器播放 MP4 视频时必须支持 Range 请求才能拖动进度条
    """
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        range_header = self.headers.get('Range')
        if not range_header or not range_header.startswith('bytes='):
            return super().send_head()

        fs = os.fstat(f.fileno())
        total_length = fs.st_size

        match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if not match:
            return super().send_head()

        start_str, end_str = match.groups()
        start = int(start_str)
        end = int(end_str) if end_str else total_length - 1

        if start >= total_length:
            self.send_error(416, "Requested Range Not Satisfiable")
            f.close()
            return None

        end = min(end, total_length - 1)
        content_length = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{total_length}")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        f.seek(start)
        return f

    def end_headers(self):
        # 允许跨域与缓存
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

def print_banner(lan_ip, port):
    url = f"http://{lan_ip}:{port}/dashboard.html"
    print("\n" + "=" * 65)
    print("  🚀 X-Media-Downloader 安卓远程流媒体服务已就绪！")
    print("=" * 65)
    print(f"\n  📡 电脑局域网 IP : {lan_ip}")
    print(f"  📱 手机浏览器访问: \033[92m{url}\033[0m")
    print("\n  💡 使用方法：")
    print("  1. 确保安卓手机与本电脑连接在【同一个 Wi-Fi (局域网)】下；")
    print("  2. 在安卓手机自带浏览器、Chrome 或微信中打开上方链接；")
    print("  3. 即可直接无线浏览电脑中所有抓取的推文、大图及流畅播放高码率视频！")
    print("  4. 视频播放支持 HTTP Range 随心拖动进度条，不占用手机一分钱存储空间！")
    print("\n  （按 Ctrl + C 可随时停止本服务）")
    print("=" * 65 + "\n")

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    lan_ip = get_lan_ip()

    try:
        server = HTTPServer(('0.0.0.0', PORT), VideoStreamingHTTPRequestHandler)
    except OSError as e:
        print(f"⚠️ 端口 {PORT} 被占用，尝试端口 {PORT + 1}...")
        server = HTTPServer(('0.0.0.0', PORT + 1), VideoStreamingHTTPRequestHandler)

    actual_port = server.server_port
    print_banner(lan_ip, actual_port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 远程观看服务已安全关闭。")

if __name__ == '__main__':
    main()
