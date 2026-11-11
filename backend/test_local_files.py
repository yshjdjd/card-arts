import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services.local_files import FileGrants
from app.core.desktop_auth import DesktopAuth

class FileTests(unittest.TestCase):
    def test_paths_permissions_and_revocation(self):
        with tempfile.TemporaryDirectory() as directory:
            roots=FileGrants();root=Path(directory)/'authorized';root.mkdir()
            key=roots.grant(str(root))['id']
            self.assertEqual(roots.resolve(key,'a.txt'),root/'a.txt')
            for path in ('../outside','/tmp/a','C:/secret','a\\b','file:stream'):
                with self.assertRaises(ValueError):roots.resolve(key,path)
            with self.assertRaises(ValueError):roots.resolve(key,'a.txt',True)
            roots.roots.pop(key)
            with self.assertRaises(ValueError):roots.resolve(key,'')

    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'allowed';root.mkdir();outside=Path(directory)/'outside';outside.mkdir()
            try:(root/'link').symlink_to(outside,target_is_directory=True)
            except OSError:self.skipTest('平台未授权创建符号链接')
            roots=FileGrants();key=roots.grant(str(root))['id']
            with self.assertRaises(ValueError):roots.resolve(key,'link/file')

    def test_auth_and_origin(self):
        app=FastAPI();app.add_middleware(DesktopAuth)
        @app.get('/api/v1/test')
        def read():return {'ok':True}
        with patch.dict(os.environ,{'CARDARTS_DESKTOP':'1','CARDARTS_SESSION_TOKEN':'secret'}),TestClient(app,base_url='http://127.0.0.1:8765') as client:
            self.assertEqual(client.get('/api/v1/test').status_code,401)
            self.assertEqual(client.post('/api/v1/local/session',headers={'Authorization':'Bearer wrong'}).status_code,401)
            self.assertEqual(client.post('/api/v1/local/session',headers={'Authorization':'Bearer secret'}).status_code,200)
            self.assertEqual(client.get('/api/v1/test').status_code,200)
            self.assertEqual(client.get('/api/v1/test',headers={'Origin':'https://untrusted.example'}).status_code,403)
            self.assertEqual(client.get('/api/v1/test',headers={'Host':'untrusted.example'}).status_code,403)

    def test_file_api_no_overwrite_and_readonly(self):
        from app.api.v1.local_files import router
        from app.services.local_files import grants
        from app.db.session import get_session
        app=FastAPI();app.include_router(router)
        async def session():yield None
        app.dependency_overrides[get_session]=session
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'CARDARTS_DESKTOP':'1','CARDARTS_SESSION_TOKEN':'test'}),TestClient(app) as client:
            key=grants.grant(directory,True)['id']
            def call(op,path,**kw):return client.post('/local/files',json={'grant':key,'path':path,'operation':op,**kw})
            self.assertEqual(call('write','a.txt',text='测试').status_code,200)
            self.assertEqual(call('write','a.txt',text='覆盖').status_code,400)
            self.assertEqual(call('read','a.txt').json()['text'],'测试')
            self.assertEqual(call('copy','a.txt',target='b.txt').status_code,200)
            self.assertEqual(call('move','b.txt',target='c.txt').status_code,200)
            self.assertFalse((Path(directory)/'b.txt').exists())
            self.assertEqual(call('read','../secret').status_code,400)
            readonly=grants.grant(directory,False)['id']
            self.assertEqual(client.post('/local/files',json={'grant':readonly,'path':'x','operation':'write','text':'x'}).status_code,400)
            grants.roots.pop(key);grants.roots.pop(readonly)

if __name__=='__main__':unittest.main()
