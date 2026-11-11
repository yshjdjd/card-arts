import {req} from '../api/client';
export type DirectoryGrant={id:string;name:string;writable:boolean};
/** 桌面框架无关；后续可替换为 Tauri IPC 适配器。 */
export const localFiles={
 roots:()=>req<DirectoryGrant[]>('/local/grants'),
 authorize:()=>req<DirectoryGrant|{cancelled:true}>('/local/grant',{method:'POST'}),
 revoke:(id:string)=>req('/local/grants/'+encodeURIComponent(id),{method:'DELETE'}),
 execute:(body:{grant:string;path?:string;operation:string;target?:string;text?:string;project_id?:string},signal?:AbortSignal)=>req<Record<string,unknown>>('/local/files',{method:'POST',body:JSON.stringify(body),signal}),
};
