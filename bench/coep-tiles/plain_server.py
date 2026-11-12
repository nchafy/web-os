import sys, os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
class H(SimpleHTTPRequestHandler):           # deliberately NO CORS, NO CORP
    def log_message(self, *a): pass
os.chdir(sys.argv[2])
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
