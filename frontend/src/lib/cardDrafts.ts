import type { Card, Deck, LayoutElement } from './types';

export const cardDraftKey=(deckId:string,cardId:string)=>JSON.stringify([deckId,cardId]);
export function applyCardValues(deck:Deck,cardId:string,patch:Record<string,unknown>){
  const card=deck.cards.find(c=>c.id===cardId);if(!card)throw new Error('卡牌已删除，草稿尚未保存');
  for(const [id,value] of Object.entries(patch)){
    const field=deck.fields.find(f=>f.id===id);if(!field)throw new Error(`字段 ${id} 已删除，草稿尚未保存`);
    if(field.type==='number'&&value!==''&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error(`「${field.name}」需要有效数字`);
    if(field.id==='count'&&field.type==='number'&&value!==''&&(!Number.isInteger(value)||Number(value)<0))throw new Error('数量需要非负整数');
    if(field.type==='boolean'&&typeof value!=='boolean')throw new Error(`「${field.name}」需要布尔值`);
    if(field.type==='select'&&value!==''&&!field.options?.includes(String(value)))throw new Error(`「${field.name}」选项已变化，请重新选择`);
    if(!['number','boolean'].includes(field.type)&&typeof value!=='string')throw new Error(`「${field.name}」需要文本或素材 ID`);
  }
  Object.assign(card.values,structuredClone(patch));
}
export function boundFieldIds(el:LayoutElement,deck:Deck):string[]{
  const ids=new Set<string>();if(el.fieldId)ids.add(el.fieldId);
  for(const text of [el.text,el.fill,el.color,el.borderColor])for(const match of (text??'').matchAll(/\{([^{}]+)\}/g))ids.add(match[1]);
  return [...ids].filter(id=>deck.fields.some(f=>f.id===id));
}
type Entry={overlay:Record<string,unknown>;pending:Record<string,unknown>;paused:Set<string>;timer?:ReturnType<typeof setTimeout>;saving?:Promise<boolean>;error?:string};
/** Per-card debounced drafts; only changed fields are committed, never full card snapshots. */
export class CardDrafts {
  private entries=new Map<string,Entry>();private listeners=new Set<()=>void>();private version=0;
  constructor(private save:(key:string,patch:Record<string,unknown>)=>Promise<void>,private delay=600){}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
  snapshot=()=>this.version;
  private publish(){this.version++;this.listeners.forEach(f=>f());}
  private entry(key:string){let e=this.entries.get(key);if(!e){e={overlay:{},pending:{},paused:new Set()};this.entries.set(key,e);}return e;}
  private schedule(key:string,e:Entry){if(e.timer)clearTimeout(e.timer);e.timer=undefined;if(!e.paused.size)e.timer=setTimeout(()=>{void this.flush(key);},this.delay);}
  edit(key:string,field:string,value:unknown){const e=this.entry(key);if(field in e.overlay&&Object.is(e.overlay[field],value))return;e.overlay[field]=structuredClone(value);e.pending[field]=structuredClone(value);e.error=undefined;this.schedule(key,e);this.publish();}
  pause(key:string,field:string,on:boolean){const e=this.entry(key);if(on)e.paused.add(field);else e.paused.delete(field);this.schedule(key,e);this.publish();}
  view(deckId:string,card:Card):Card{const e=this.entries.get(cardDraftKey(deckId,card.id));return e&&Object.keys(e.overlay).length?{...card,values:{...card.values,...e.overlay}}:card;}
  reconcile(decks:Deck[]){let changed=false;for(const d of decks)for(const card of d.cards){const e=this.entries.get(cardDraftKey(d.id,card.id));if(!e)continue;for(const field of Object.keys(e.overlay))if(!(field in e.pending)&&!e.saving&&!e.paused.has(field)){delete e.overlay[field];changed=true;}}if(changed)this.publish();}
  status(key:string){const e=this.entries.get(key);return e?.error?'error':e?.saving?'saving':e?.paused.size?'composing':e&&Object.keys(e.pending).length?'pending':'saved';}
  error(key:string){return this.entries.get(key)?.error;}
  failures(){return [...this.entries.entries()].filter(([,e])=>!!e.error).map(([key,e])=>({key,error:e.error!,values:structuredClone(e.overlay)}));}
  hasUnsaved(){return [...this.entries.values()].some(e=>!!e.saving||!!Object.keys(e.pending).length);}
  async flush(key:string):Promise<boolean>{
    const e=this.entries.get(key);if(!e)return true;if(e.timer)clearTimeout(e.timer);e.timer=undefined;
    if(e.saving){const result=await e.saving;return result?this.flush(key):false;}
    if(e.paused.size)return false;if(!Object.keys(e.pending).length)return true;
    const patch=structuredClone(e.pending);e.pending={};
    const saving=Promise.resolve().then(()=>this.save(key,patch)).then(()=>{e.error=undefined;return true;},error=>{e.pending={...patch,...e.pending};e.error=(error as Error).message||'保存失败';return false;});
    e.saving=saving;this.publish();const result=await saving;e.saving=undefined;this.publish();
    return result&&Object.keys(e.pending).length?this.flush(key):result;
  }
  async flushAll(finishComposition=false){if(finishComposition)for(const e of this.entries.values())e.paused.clear();return (await Promise.all([...this.entries.keys()].map(key=>this.flush(key)))).every(Boolean);}
  async discard(key:string){const e=this.entries.get(key);if(e?.timer)clearTimeout(e.timer);if(e?.saving)await e.saving;this.entries.delete(key);this.publish();}
}
