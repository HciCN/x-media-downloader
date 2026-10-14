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
import json
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

# 兼容 Windows 控制台编码，防止 emoji 或中文在部分控制台引发 UnicodeEncodeError
if sys.platform.startswith('win'):
    try:
        os.system('')  # 启用 VT100 控制台转义序列
    except Exception:
        pass
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    except Exception:
        pass

PORT = 8080
DATA_FILE = os.path.join(_curr_dir, 'remote_tasks_db.json')

def load_remote_db():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {'tasks': [], 'items': {}}

def save_remote_db(data):
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[DB] 保存失败: {e}")

def get_lan_ip():
    """
    智能获取电脑在真实物理局域网（Wi-Fi / 以太网）中的 IPv4 地址
    自动过滤 Clash/Mihomo/VPN 虚拟网卡（198.18.x.x, 10.x 等虚拟接口）和回环地址
    """
    candidates = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith(('127.', '169.254.', '198.18.', '198.19.')):
                candidates.append(ip)
    except Exception:
        pass

    for gw in ['192.168.0.1', '192.168.1.1', '192.168.31.1', '192.168.123.1', '10.0.0.1']:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((gw, 80))
            ip = s.getsockname()[0]
            s.close()
            if not ip.startswith(('127.', '169.254.', '198.18.', '198.19.')):
                if ip not in candidates:
                    candidates.insert(0, ip)
                else:
                    candidates.remove(ip)
                    candidates.insert(0, ip)
                break
        except Exception:
            pass

    for ip in candidates:
        if ip.startswith('192.168.'):
            return ip

    return candidates[0] if candidates else '127.0.0.1'

class VideoStreamingHTTPRequestHandler(SimpleHTTPRequestHandler):
    """
    支持 HTTP 206 Partial Content (Range 请求) 与移动端远程数据 API 的流媒体处理器
    """
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 根路径自动重定向至控制台
        if path in ('', '/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/dashboard.html')
            self.end_headers()
            return

        # API: 获取任务列表 (供手机端免扩展调用)
        if path == '/api/tasks':
            db = load_remote_db()
            body = json.dumps({'success': True, 'tasks': db.get('tasks', [])}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 获取单任务详情
        if path == '/api/task_detail':
            qs = urllib.parse.parse_qs(parsed.query)
            task_id = qs.get('id', [''])[0]
            db = load_remote_db()
            task = next((t for t in db.get('tasks', []) if t.get('id') == task_id), None)
            items = db.get('items', {}).get(task_id, [])
            if not task and db.get('tasks'):
                task = db['tasks'][0]
                items = db.get('items', {}).get(task.get('id'), [])

            body = json.dumps({'success': True, 'task': task, 'items': items}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 电脑局域网信息
        if path == '/api/lan_info':
            lan_ip = get_lan_ip()
            body = json.dumps({'ip': lan_ip, 'port': self.server.server_port}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/sync_task':
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(length).decode('utf-8')
                payload = json.loads(raw_body)
                task = payload.get('task')
                items = payload.get('items', [])

                if task and task.get('id'):
                    task_id = task['id']
                    db = load_remote_db()
                    existing_idx = next((i for i, t in enumerate(db['tasks']) if t.get('id') == task_id), -1)
                    if existing_idx >= 0:
                        db['tasks'][existing_idx] = task
                    else:
                        db['tasks'].insert(0, task)
                    db.setdefault('items', {})[task_id] = items
                    save_remote_db(db)
                    print(f"  [+] 成功同步任务: @{task.get('x_screen_name', '')} (含 {len(items)} 条媒体)")

                resp = json.dumps({'success': True}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(resp)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_error(500, str(e))
            return

        if path == '/api/sync_all':
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(length).decode('utf-8')
                payload = json.loads(raw_body)
                tasks = payload.get('tasks', [])
                items_map = payload.get('itemsMap', {})

                db = load_remote_db()
                for task in tasks:
                    t_id = task.get('id')
                    existing_idx = next((i for i, t in enumerate(db['tasks']) if t.get('id') == t_id), -1)
                    if existing_idx >= 0:
                        db['tasks'][existing_idx] = task
                    else:
                        db['tasks'].insert(0, task)
                    if t_id and t_id in items_map:
                        db.setdefault('items', {})[t_id] = items_map[t_id]
                save_remote_db(db)
                print(f"  [+] 批量同步完成: 共 {len(tasks)} 个任务")

                resp = json.dumps({'success': True, 'count': len(tasks)}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(resp)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_error(500, str(e))
            return

        self.send_error(404, "Unknown API")

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
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

def print_banner(lan_ip, port):
    url = f"http://{lan_ip}:{port}/dashboard.html"
    root_url = f"http://{lan_ip}:{port}/"
    print("\n" + "=" * 65)
    print("  >> X-Media-Downloader 安卓远程流媒体服务已就绪！")
    print("=" * 65)
    print(f"\n  [局域网 IP]   : {lan_ip}")
    print(f"  [手机端访问] : {root_url}")
    print(f"  [控制台直达] : {url}")

    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(root_url)
        qr.make(fit=True)
        print("\n  [手机扫码直接打开]：")
        qr.print_ascii(invert=True)
    except Exception:
        pass

    print("\n  [使用说明]：")
    print("  1. 确保安卓手机与电脑连接在【同一个 Wi-Fi (局域网)】；")
    print("  2. 在安卓手机自带浏览器、微信、夸克或 Chrome 中扫码或输入上方网址；")
    print("  3. 电脑端控制台会自动将抓取的推文与媒体同步至手机端，手机免下载流畅看！")
    print("  4. 视频播放支持 HTTP 206 Range 随心拖动进度条，不占用手机存储空间！")
    print("\n  （按 Ctrl + C 可随时停止本服务）")
    print("=" * 65 + "\n")

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    lan_ip = get_lan_ip()

    try:
        server = HTTPServer(('0.0.0.0', PORT), VideoStreamingHTTPRequestHandler)
    except OSError as e:
        print(f">> 端口 {PORT} 被占用，尝试端口 {PORT + 1}...")
        server = HTTPServer(('0.0.0.0', PORT + 1), VideoStreamingHTTPRequestHandler)

    actual_port = server.server_port
    print_banner(lan_ip, actual_port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n>> 远程观看服务已安全关闭。")

if __name__ == '__main__':
    main()
