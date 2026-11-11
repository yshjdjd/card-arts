import React,{useState} from 'react';
import {localFiles,type DirectoryGrant} from '../lib/localFiles';
export default function LocalFilesPanel(){
 const [roots,setRoots]=useState<DirectoryGrant[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();setRoots(await localFiles.roots());}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="mt8"><h3>本机文件访问</h3><p className="small faint">仅桌面启动模式可用。手动授权文件夹后，Agent 可使用相对路径读取、创建、复制、移动和导入素材；不支持覆盖或删除。授权在重启后失效。</p><button className="btn" disabled={busy} onClick={()=>void run(()=>localFiles.authorize())}>选择并授权文件夹</button><button className="btn" disabled={busy} onClick={()=>void run(()=>localFiles.roots())}>刷新授权</button>{roots.map(r=><div key={r.id}>{r.name} · {r.writable?'可写':'只读'} <button className="btn sm" disabled={busy} onClick={()=>void run(()=>localFiles.revoke(r.id))}>撤销授权</button></div>)}{error&&<div role="alert">{error}</div>}</section>;
}
