import type {LayoutElement} from './types';
export const MATERIALS=[
 {id:'gold',name:'鎏金',from:'#fff2ad',to:'#8b5a16',border:'#6d4715'},
 {id:'silver',name:'银色',from:'#ffffff',to:'#697787',border:'#4b5563'},
 {id:'bronze',name:'青铜',from:'#c8b77f',to:'#395f51',border:'#3f4b32'},
 {id:'parchment',name:'古纸',from:'#fff4d4',to:'#ceb57c',border:'#927342'},
 {id:'jade',name:'碧玉',from:'#b2dbc1',to:'#245540',border:'#214c3a'},
 {id:'lacquer',name:'朱漆',from:'#c84c3c',to:'#531818',border:'#d5ac59'},
];
export function materialProperties(id:string):Partial<LayoutElement>{
 const m=MATERIALS.find(m=>m.id===id);if(!m)throw new Error('未知材质预设');
 return {fill:m.from,gradient:{from:m.from,to:m.to,angle:110},borderColor:m.border,borderWidth:2,
 shadow:{color:'#00000055',blur:4,x:1,y:2},textureAssetId:undefined,textureMode:undefined,textureScale:undefined,fillOpacity:1,borderOpacity:1};
}
