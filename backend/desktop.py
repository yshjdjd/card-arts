"""单进程桌面服务启动器：python desktop.py；Ctrl+C 关闭服务，无端口扫描或杀进程。"""
import os
import secrets
import socket
import threading
import time
import webbrowser
import json
import sys
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

def main():
    # 无控制台 EXE 的标准流为 None；部分 GUI/CLR 依赖仍会访问它们。
    if sys.stdout is None:sys.stdout=open(os.devnull,'w',encoding='utf-8')
    if sys.stderr is None:sys.stderr=open(os.devnull,'w',encoding='utf-8')
    root=Path(sys._MEIPASS) if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent
    if not (root/'frontend/dist/index.html').exists():
        raise SystemExit('请先运行 npm --prefix frontend run build')
    os.environ['CARDARTS_DESKTOP']='1'
    token=secrets.token_urlsafe(32);os.environ['CARDARTS_SESSION_TOKEN']=token
    import uvicorn
    from app.main import app
    from app.core.config import DATA_DIR
    DATA_DIR.mkdir(parents=True,exist_ok=True)
    (DATA_DIR/'logs').mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO,handlers=[RotatingFileHandler(DATA_DIR/'logs/desktop.log',maxBytes=2*1024*1024,backupCount=3,encoding='utf-8'),logging.StreamHandler()])
    state=DATA_DIR/'desktop.json'
    saved=json.loads(state.read_text(encoding='utf-8')) if state.exists() else {}
    sock=socket.socket()
    try:sock.bind(('127.0.0.1',int(saved.get('port',0))))
    except OSError:raise SystemExit('已保存的桌面端口被占用。请先关闭旧实例；为保留浏览器本地数据，不自动切换已有工程的来源端口。')
    sock.listen(128)
    port=sock.getsockname()[1]
    state.write_text(json.dumps({'port':port}),encoding='utf-8')
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=port,access_log=False,log_config=None,timeout_graceful_shutdown=5))
    if getattr(sys,'frozen',False) or '--native' in sys.argv:
        import webview
        worker=threading.Thread(target=lambda:server.run(sockets=[sock]),daemon=True)
        worker.start()
        deadline=time.monotonic()+30
        while not server.started and worker.is_alive() and time.monotonic()<deadline:time.sleep(.1)
        if not server.started:server.should_exit=True;worker.join(6);raise RuntimeError('本机服务启动失败，请检查用户数据目录下 logs/desktop.log')
        url=f'http://127.0.0.1:{port}/#desktop-session={token}'
        webview.settings['ALLOW_DOWNLOADS']=True
        window=webview.create_window('CardArts',url,width=1440,height=960,min_size=(1024,680),text_select=True)
        try:webview.start(gui='edgechromium',private_mode=False,storage_path=str(DATA_DIR.parent/'webview'))
        finally:server.should_exit=True;worker.join(10);sock.close()
        return
    def open_when_ready():
        deadline=time.monotonic()+30
        while not server.started and not server.should_exit and time.monotonic()<deadline:time.sleep(.1)
        if server.started and os.getenv('CARDARTS_NO_BROWSER')!='1':webbrowser.open(f'http://127.0.0.1:{port}/#desktop-session={token}')
        elif server.started:return
        else:server.should_exit=True
    threading.Thread(target=open_when_ready,daemon=True).start()
    print(f'CardArts 桌面服务：http://127.0.0.1:{port}（Ctrl+C 关闭）')
    try:server.run(sockets=[sock])
    finally:sock.close()

if __name__=='__main__':
    try:main()
    except Exception as error:
        logging.exception('桌面应用启动失败')
        if getattr(sys,'frozen',False):
            import ctypes
            ctypes.windll.user32.MessageBoxW(0,str(error),'CardArts 启动失败',0x10)
        else:raise
