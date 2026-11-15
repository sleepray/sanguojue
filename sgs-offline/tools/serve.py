#!/usr/bin/env python3
"""本地静态服务器（线程化，避免并发资源请求被 reset）。"""
import os, sys, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *args):
        pass

class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True

if __name__ == '__main__':
    os.chdir(ROOT)
    httpd = Server(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    print(f'serving {ROOT} at http://127.0.0.1:{PORT}/')
    httpd.serve_forever()
