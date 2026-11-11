import assert from 'node:assert/strict';
import {build} from 'esbuild';
const rows=new Map();globalThis.workspaceTestRows=rows;
const result=await build({entryPoints:['src/db/workspace.ts'],bundle:true,platform:'node',format:'esm',write:false,define:{'import.meta.env':'{}'},plugins:[{name:'test',setup(b){b.onResolve({filter:/schema$/},()=>({path:'schema',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`export const db={projects:{get:async id=>globalThis.workspaceTestRows.get(id),put:async p=>globalThis.workspaceTestRows.set(p.id,p)},assets:{get:async()=>null,put:async()=>{}},folders:{put:async()=>{}}};export const getSetting=async()=>null;export const setSetting=async()=>{};`}));}}]});
const W=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
class Directory{
 constructor(name,files={}){this.name=name;this.files=files;this.writes=0;}
 async requestPermission(){return 'granted';}
 async getDirectoryHandle(name){const d=this.files[name];if(!(d instanceof Directory))throw Error('missing');return d;}
 async getFileHandle(name,options){assert.ok(!name.includes('/'));if(options?.create){this.writes++;throw Error('unexpected write');}if(!(name in this.files))throw Error('missing');return {getFile:async()=>({text:async()=>JSON.stringify(this.files[name])})};}
 async *keys(){yield* Object.keys(this.files);}
}
const project={id:'p',name:'old project',content:{decks:[]},updatedAt:'2026-11-11'};
const projects=new Directory('projects',{'old-p.json':project});
const root=new Directory('workspace',{'cardarts.json':{projects:[{id:'p',file:'projects/old-p.json'}],assets:[]},projects});
globalThis.window={showDirectoryPicker:async()=>root};
await W.connectWorkspace();assert.equal(rows.get('p').name,'old project');assert.equal(root.writes,0);assert.equal(projects.writes,0);
rows.clear();root.files['cardarts.json']={projects:[]};
await W.connectWorkspace();assert.equal(rows.get('p').name,'old project');assert.equal(root.writes,0);
console.log('PASS: relative path recovery; restore before write; empty-index file recovery; no disk writes');
