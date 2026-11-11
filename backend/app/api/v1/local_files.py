import asyncio
import mimetypes
import os
import shutil
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.local_files import grants
from app.db.session import get_session
from app.services.upload_service import create_from_bytes
from app.api.v1.assets import _asset_out

router=APIRouter(prefix='/local',tags=['desktop-files'])

def enabled():
    if os.getenv('CARDARTS_DESKTOP')!='1' or not os.getenv('CARDARTS_SESSION_TOKEN'):
        raise HTTPException(403,'文件功能仅在带认证的本机桌面模式开放')

class Request(BaseModel):
    grant: str = ''
    path: str = ''
    operation: str = 'list'
    target: str = ''
    text: str = ''
    project_id: str = ''

@router.get('/grants',dependencies=[Depends(enabled)])
def list_grants():
    return [{'id':k,'name':p.name,'writable':w} for k,(p,w) in grants.roots.items()]

@router.post('/grant',dependencies=[Depends(enabled)])
def pick_directory():
    # 路径不由模型参数提交；用户必须在本机原生对话框中明确选择。
    import tkinter as tk
    from tkinter import filedialog, messagebox
    window=tk.Tk();window.withdraw()
    try:
        path=filedialog.askdirectory(parent=window,title='授权 CardArts / Agent 访问文件夹（取消可退出）')
        if not path:return {'cancelled':True}
        writable=messagebox.askyesno('目录访问权限','是否允许创建、写入、复制和移动文件？\n选择“否”则仅允许读取和导入素材。',parent=window)
        return grants.grant(path,writable)
    finally:window.destroy()

@router.delete('/grants/{key}',dependencies=[Depends(enabled)])
def revoke(key:str):
    grants.roots.pop(key,None)
    return {'revoked':True}

@router.post('/files',dependencies=[Depends(enabled)])
async def files(body:Request,session:AsyncSession=Depends(get_session)):
    try:
        def perform():
            p=grants.resolve(body.grant,body.path,body.operation in ('write','mkdir','copy','move'))
            if body.operation=='list':
                return {'items':[{'name':x.name,'directory':x.is_dir()} for x in sorted(p.iterdir(),key=lambda x:x.name)][:500]}
            if body.operation=='read':
                if p.stat().st_size>1024*1024:raise ValueError('文本读取上限 1 MB')
                return {'text':p.read_text(encoding='utf-8-sig')}
            if body.operation=='mkdir':p.mkdir();return {'created':body.path}
            if body.operation=='write':
                if len(body.text.encode('utf-8'))>1024*1024:raise ValueError('文本写入上限 1 MB')
                with p.open('x',encoding='utf-8') as f:f.write(body.text)
                return {'created':body.path}
            if body.operation in ('copy','move'):
                dest=grants.resolve(body.grant,body.target,True)
                if not p.is_file():raise ValueError('仅支持单文件复制和移动')
                # 独占创建目标，禁止覆盖；不执行目录递归移动或删除。
                with p.open('rb') as src,dest.open('xb') as out:shutil.copyfileobj(src,out)
                if body.operation=='move':p.unlink()
                return {'target':body.target}
            if body.operation=='import':
                if p.stat().st_size>32*1024*1024:raise ValueError('本地导入上限 32 MB')
                return (p.name,mimetypes.guess_type(p.name)[0] or 'application/octet-stream',p.read_bytes())
            raise ValueError('未知文件操作')
        result=await asyncio.to_thread(perform)
        if body.operation=='import':
            from app.models.project import Project
            if not body.project_id or await session.get(Project,body.project_id) is None:raise ValueError('请先将当前项目同步到本机后端，再导入素材')
            name,mime,data=result
            from app.core.config import get_settings
            if mime not in get_settings().allowed_asset_types:raise ValueError('仅支持允许的图片和字体类型')
            asset=await create_from_bytes(session,project_id=body.project_id,filename=name,mime=mime,data=data)
            await session.commit()
            return {'asset':_asset_out(asset)}
        return result
    except (ValueError,OSError,UnicodeError) as e:
        raise HTTPException(400,str(e)) from e
