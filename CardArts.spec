from pathlib import Path
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules
root=Path(SPECPATH)
datas=[(str(root/'frontend/dist'),'frontend/dist'),(str(root/'data/game-icons'),'data/game-icons'),(str(root/'docs'),'docs')]
binaries=[]
hidden=['aiosqlite','sqlalchemy.dialects.sqlite.aiosqlite','uvicorn.logging','uvicorn.loops.asyncio','uvicorn.protocols.http.h11_impl','uvicorn.protocols.websockets.websockets_impl','uvicorn.lifespan.on']
for package in ['webview','clr_loader']:
    d,b,h=collect_all(package);datas+=d;binaries+=b;hidden+=h
a=Analysis([str(root/'backend/desktop.py')],pathex=[str(root/'backend')],datas=datas,binaries=binaries,hiddenimports=hidden,excludes=['PyQt5','PyQt6','PySide2','PySide6','pytest','IPython'],noarchive=False)
pyz=PYZ(a.pure)
exe=EXE(pyz,a.scripts,[],exclude_binaries=True,name='CardArts',console=os.getenv("CARDARTS_BUILD_CONSOLE")=="1",disable_windowed_traceback=False)
coll=COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='CardArts')
