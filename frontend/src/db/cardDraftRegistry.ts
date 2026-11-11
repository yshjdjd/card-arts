import { mutateProject } from './schema';
import { CardDrafts, applyCardValues } from '../lib/cardDrafts';

// Keep failed drafts across local page navigation; each writer is bound to a project ID.
const drafts=new Map<string,CardDrafts>();
export async function flushProjectCardDrafts(projectId:string){return await drafts.get(projectId)?.flushAll()??true;}
export function projectCardDrafts(projectId:string):CardDrafts{
  let store=drafts.get(projectId);
  if(!store){store=new CardDrafts(async(key,patch)=>{
    const [deckId,cardId]=JSON.parse(key) as [string,string];let applied=false;
    await mutateProject(projectId,project=>{const deck=project.content.decks.find(d=>d.id===deckId);if(!deck)throw new Error('牌组已删除，草稿尚未保存');applyCardValues(deck,cardId,patch);applied=true;},'版式中编辑卡牌数据');
    if(!applied)throw new Error('项目已删除，草稿尚未保存');
  });drafts.set(projectId,store);}
  return store;
}
