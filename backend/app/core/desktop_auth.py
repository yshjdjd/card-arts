import os
import secrets
from urllib.parse import urlparse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

class DesktopAuth(BaseHTTPMiddleware):
    async def dispatch(self,request,call_next):
        if os.getenv('CARDARTS_DESKTOP')!='1':return await call_next(request)
        token=os.getenv('CARDARTS_SESSION_TOKEN','')
        host=request.url.hostname
        if host not in ('127.0.0.1','localhost','::1') or not token:
            return JSONResponse({'detail':'本机会话未就绪'},403)
        cookie='cardarts_session_'+str(request.url.port or 80)
        origin=request.headers.get('origin')
        if origin and origin!=f'{request.url.scheme}://{request.url.netloc}':
            return JSONResponse({'detail':'拒绝跨来源请求'},403)
        if request.url.path=='/api/v1/local/session' and request.method=='POST':
            if not secrets.compare_digest(request.headers.get('authorization',''),'Bearer '+token):return JSONResponse({'detail':'会话认证失败'},401)
            response=JSONResponse({'ok':True});response.set_cookie(cookie,token,httponly=True,samesite='strict',path='/');return response
        if request.url.path.startswith('/api/'):
            if not secrets.compare_digest(request.cookies.get(cookie,''),token):return JSONResponse({'detail':'需要本机会话认证'},401)
        return await call_next(request)
