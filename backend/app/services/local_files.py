"""桌面文件边界：授权仅在当前进程存活，Agent 不具有授予目录的工具。"""
from pathlib import Path, PureWindowsPath
from secrets import token_urlsafe

class FileGrants:
    def __init__(self):
        self.roots = {}

    def grant(self, path: str, writable: bool = False):
        root = Path(path).expanduser().resolve(strict=True)
        if not root.is_dir() or root.parent == root:
            raise ValueError('请选择具体文件夹，不能授权整个磁盘')
        key = token_urlsafe(18)
        self.roots[key] = (root, writable)
        return {'id': key, 'name': root.name, 'writable': writable}

    def resolve(self, key: str, relative: str = '', write: bool = False):
        if key not in self.roots:
            raise ValueError('目录未授权或授权已过期')
        root, writable = self.roots[key]
        if write and not writable:
            raise ValueError('目录仅授权读取')
        if '\\' in relative or ':' in relative or PureWindowsPath(relative).is_absolute() or Path(relative).is_absolute():
            raise ValueError('必须使用授权目录内的相对路径，分隔符为 /')
        target = (root / relative).resolve()
        if not target.is_relative_to(root):
            raise ValueError('路径超出授权目录')
        return target

grants = FileGrants()
