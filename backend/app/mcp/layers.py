"""Layer operations use the same bottom-to-top ordering as the canvas renderer."""
from copy import deepcopy
from uuid import uuid4


def apply_layers(elements, operation, ids, *, target=None, name=None, order=None, expand_groups=True):
    known = {e['id'] for e in elements}
    if len(known) != len(elements):
        raise ValueError('图层 ID 重复')
    if operation not in {'front', 'back', 'up', 'down', 'above', 'below', 'order', 'rename', 'renameGroup', 'show', 'hide', 'lock', 'unlock', 'group', 'ungroup'}:
        raise ValueError('未知图层操作')
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise ValueError('ids 必须是图层 ID 数组')
    chosen = set(ids)
    if operation != 'order' and (not chosen or not chosen <= known):
        raise ValueError('请先 list_layers 查询真实图层 ID')
    if (expand_groups or operation == 'renameGroup') and operation != 'rename':
        groups = {e.get('groupId') for e in elements if e['id'] in chosen and e.get('groupId')}
        chosen.update(e['id'] for e in elements if e.get('groupId') and e.get('groupId') in groups)
    if operation == 'order' and (not isinstance(order, list) or not all(isinstance(i, str) for i in order) or len(order) != len(elements) or len(set(order)) != len(elements) or set(order) != known):
        raise ValueError('order 必须是完整且不重复的底层到顶层 ID 数组')
    if operation not in {'show', 'hide', 'lock', 'unlock'} and any(e.get('locked') and (e['id'] in chosen or (operation == 'order' and order.index(e['id']) != i)) for i, e in enumerate(elements)):
        raise ValueError('图层已锁定，请先解锁')
    result = deepcopy(elements)
    selected = [e for e in result if e['id'] in chosen]
    rest = [e for e in result if e['id'] not in chosen]
    if operation == 'order':
        by_id = {e['id']: e for e in result}
        return [by_id[i] for i in order]
    if operation == 'front':
        return rest + selected
    if operation == 'back':
        return selected + rest
    if operation in {'up', 'down'}:
        indexes = range(len(result) - 2, -1, -1) if operation == 'up' else range(1, len(result))
        step = 1 if operation == 'up' else -1
        for i in indexes:
            if result[i]['id'] in chosen and result[i + step]['id'] not in chosen:
                result[i], result[i + step] = result[i + step], result[i]
        return result
    if operation in {'above', 'below'}:
        index = next((i for i, e in enumerate(rest) if e['id'] == target), None)
        if index is None:
            raise ValueError('target 必须在所选图层之外')
        index += operation == 'above'
        return rest[:index] + selected + rest[index:]
    if operation == 'renameGroup':
        groups = {e.get('groupId') for e in selected}
        if len(groups) != 1 or None in groups or not isinstance(name, str) or not name.strip():
            raise ValueError('请选择同一组的成员并提供非空组名')
        for e in selected:
            e['groupName'] = name.strip()[:120]
    elif operation == 'rename':
        if len(selected) != 1 or not isinstance(name, str) or not name.strip():
            raise ValueError('重命名需一个图层和非空 name')
        selected[0]['name'] = name.strip()[:120]
    elif operation in {'show', 'hide'}:
        for e in selected:
            e['hidden'] = operation == 'hide'
    elif operation in {'lock', 'unlock'}:
        for e in selected:
            e['locked'] = operation == 'lock'
    elif operation == 'group':
        if len(selected) < 2:
            raise ValueError('组合至少需要两个图层')
        group = str(uuid4())
        for e in selected:
            e['groupId'] = group
            e['groupName'] = (name.strip()[:120] if isinstance(name, str) and name.strip() else '未命名组')
    elif operation == 'ungroup':
        for e in selected:
            e.pop('groupId', None)
            e.pop('groupName', None)
    return result
