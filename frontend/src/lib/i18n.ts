import { useEffect, useState } from 'react';

type Lang = 'zh' | 'en';

const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    'app.name': 'CardArts',
    'app.tagline': '本地优先的卡牌设计工具',
    'nav.dashboard': '项目',
    'nav.decks': '牌组',
    'nav.cards': '卡牌数据',
    'nav.editor': '版式编辑器',
    'nav.assets': '素材库',
    'nav.icons': '内置图标库',
    'nav.documents': '项目文档',
    'nav.versions': '版本历史',
    'nav.export': '导出中心',
    'nav.settings': '设置',
    'nav.print': '打印',
    'common.save': '保存',
    'common.cancel': '取消',
    'common.delete': '删除',
    'common.rename': '重命名',
    'common.add': '新增',
    'common.edit': '编辑',
    'common.confirm': '确定',
    'common.search': '搜索',
    'common.name': '名称',
    'common.type': '类型',
    'common.actions': '操作',
    'common.empty': '暂无数据',
    'common.close': '关闭',
    'common.undo': '撤销',
    'common.redo': '重做',
    'common.copy': '复制',
    'common.paste': '粘贴',
    'common.all': '全部',
    'common.loading': '加载中…',
    'common.online': '已连接',
    'common.offline': '离线（本地模式）',
  },
  en: {
    'app.name': 'CardArts',
    'app.tagline': 'Local-first card game design tool',
    'nav.dashboard': 'Projects',
    'nav.decks': 'Decks',
    'nav.cards': 'Card Data',
    'nav.editor': 'Layout Editor',
    'nav.assets': 'Assets',
    'nav.icons': 'Icon Library',
    'nav.documents': 'Documents',
    'nav.versions': 'Versions',
    'nav.export': 'Export',
    'nav.settings': 'Settings',
    'nav.print': 'Print',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.rename': 'Rename',
    'common.add': 'Add',
    'common.edit': 'Edit',
    'common.confirm': 'Confirm',
    'common.search': 'Search',
    'common.name': 'Name',
    'common.type': 'Type',
    'common.actions': 'Actions',
    'common.empty': 'No data',
    'common.close': 'Close',
    'common.undo': 'Undo',
    'common.redo': 'Redo',
    'common.copy': 'Copy',
    'common.paste': 'Paste',
    'common.all': 'All',
    'common.loading': 'Loading…',
    'common.online': 'Connected',
    'common.offline': 'Offline (local mode)',
  },
};

let current: Lang = (localStorage.getItem('cardarts.lang') as Lang) || 'zh';
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem('cardarts.lang', l);
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  listeners.forEach((f) => f(l));
}

export function t(key: string): string {
  return DICT[current][key] ?? DICT.zh[key] ?? key;
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return [current, setLang];
}
