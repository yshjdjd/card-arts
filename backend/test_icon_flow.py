"""内置图标库端到端测试：检索 / 着色预览 / 加入自建素材库并重命名 / 批量。

运行（需后端已在 8000 端口运行）：
    python test_icon_flow.py
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000/api/v1"


def req(method: str, path: str, body: dict | None = None) -> tuple[int, dict | bytes]:
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def main() -> None:
    ok = True

    st, stats = req("GET", "/icons/stats")
    print(f"[0] 图标库 {stats}")
    ok &= st == 200 and stats.get("count", 0) > 0

    st, res = req("GET", "/icons?q=sword&limit=5")
    print(f"[1] 搜索 sword -> {res['total']} 命中，返回 {len(res['items'])}")
    ok &= st == 200 and res["total"] > 0

    icon_id = res["items"][0]["id"]

    st, svg = req("GET", f"/icons/{icon_id}/svg?color=e11d48")
    colored = svg.decode("utf-8", "ignore") if isinstance(svg, bytes) else ""
    print(f"[2] 着色预览 -> HTTP {st}, 含 fill=#e11d48: {'#e11d48' in colored}")
    ok &= st == 200 and "#e11d48" in colored

    st, proj = req("POST", "/projects", {"name": "图标测试项目"})
    pid = proj["id"]
    print(f"[3] 项目 {pid[:8]}")
    ok &= st == 201

    st, folder = req("POST", f"/assets/folders?project_id={pid}", {"name": "状态图标"})
    fid = folder["id"]
    print(f"[4] 文件夹「状态图标」{fid[:8]}")
    ok &= st == 201

    st, r1 = req("POST", "/icons/import", {
        "project_id": pid, "icon_id": icon_id,
        "name": "长剑祭坛", "folder_id": fid, "color": "#e11d48",
    })
    print(f"[5] 入库重命名 -> {r1['name']}（{r1['status']}）")
    ok &= st == 201 and r1["name"] == "长剑祭坛.svg"

    st, r2 = req("POST", "/icons/import", {
        "project_id": pid, "icon_id": icon_id,
        "name": "长剑祭坛", "folder_id": fid,
    })
    print(f"[6] 同名再入库（rename 策略）-> {r2['name']}")
    ok &= st == 201 and r2["name"] == "长剑祭坛-2.svg"

    st, r3 = req("POST", "/icons/import", {
        "project_id": pid, "icon_id": icon_id,
        "name": "长剑祭坛", "folder_id": fid, "on_conflict": "skip",
    })
    print(f"[7] 同名再入库（skip 策略）-> {r3['status']}")
    ok &= st == 201 and r3["status"] == "skipped"

    st, batch = req("POST", "/icons/import-batch", {
        "project_id": pid,
        "icon_ids": [i["id"] for i in res["items"][:3]],
        "folder_id": fid,
        "name_template": "剑-{name}-{index}",
    })
    print(f"[8] 批量入库 -> created={batch['created']}/{batch['total']}，示例名 {batch['items'][0]['name']}")
    ok &= st == 201 and batch["created"] == 3

    st, lst = req("GET", f"/assets?project_id={pid}&folder_id={fid}")
    names = [a["name"] for a in lst["items"]]
    print(f"[9] 文件夹内素材：{names}")
    ok &= st == 200 and len(lst["items"]) == 5

    print("\n全部通过 ✅" if ok else "\n存在失败 ❌")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
