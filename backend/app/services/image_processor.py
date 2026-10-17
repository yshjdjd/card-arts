"""图片处理管线。

原项目把裁切、缩略图、格式转换全放在浏览器主线程做，大图会卡死 UI。
现在移到后端，一次处理、多处复用：

    upload complete
        ├─ 元数据提取（宽高 / 格式 / 主色 / 是否透明）
        ├─ 安全校验（尺寸上限、像素炸弹、伪装扩展名）
        ├─ 派生图：thumb(256) / medium(1024) / webp 原尺寸
        └─ 可选裁切（标准卡牌 / 原图 / 自定义尺寸）→ 生成新素材

所有耗时操作通过 asyncio.to_thread 抛到线程池，不阻塞事件循环。
"""
from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass, asdict

from PIL import Image, ImageOps

from app.core.config import get_settings
from app.services.storage import save_content_addressed

# 常见卡牌比例，用于"标准卡牌"裁切目标
CARD_PRESETS: dict[str, tuple[int, int]] = {
    "poker": (750, 1050),
    "bridge": (675, 1050),
    "tarot": (825, 1425),
    "mini-american": (488, 750),
    "euro": (697, 1087),
    "square": (825, 825),
}


class ImageTooLargeError(ValueError):
    pass


class ImageDecodeError(ValueError):
    pass


@dataclass
class ImageMeta:
    width: int
    height: int
    format: str | None = None
    mode: str | None = None
    has_alpha: bool = False
    dominant_color: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class CropSpec:
    """对应原项目前端的裁切参数，现在在服务端执行。"""

    mode: str = "original"  # original | card | custom
    preset: str = "poker"  # mode=card 时生效
    width: int | None = None  # mode=custom 时生效
    height: int | None = None
    # 归一化焦点（0~1），用于决定裁切窗口位置
    focus_x: float = 0.5
    focus_y: float = 0.5
    zoom: float = 1.0


def _open(data: bytes) -> Image.Image:
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as exc:  # noqa: BLE001
        raise ImageDecodeError(f"无法解析图片: {exc}") from exc
    return im


def _dominant_color(im: Image.Image) -> str:
    """取缩略图主色，用于素材卡占位底色。"""
    small = im.convert("RGB").resize((1, 1), Image.LANCZOS)
    r, g, b = small.getpixel((0, 0))
    return f"#{r:02x}{g:02x}{b:02x}"


def _guard(im: Image.Image, data_len: int) -> None:
    s = get_settings()
    if data_len > s.UPLOAD_MAX_SIZE:
        raise ImageTooLargeError("文件超出大小上限")
    # Pillow 的解压缩炸弹保护阈值放宽到配置值
    Image.MAX_IMAGE_PIXELS = s.IMAGE_MAX_PIXELS * s.IMAGE_MAX_PIXELS
    if max(im.size) > s.IMAGE_MAX_PIXELS * 4:
        raise ImageTooLargeError(f"单边像素超过 {s.IMAGE_MAX_PIXELS * 4}")


async def extract_meta(data: bytes) -> ImageMeta:
    def _work() -> ImageMeta:
        im = _open(data)
        _guard(im, len(data))
        rgb = im.convert("RGBA")
        return ImageMeta(
            width=im.width,
            height=im.height,
            format=im.format,
            mode=im.mode,
            has_alpha=rgb.getchannel("A").getextrema()[0] < 255,
            dominant_color=_dominant_color(im),
        )

    return await asyncio.to_thread(_work)


async def build_variants(data: bytes, mime: str) -> dict:
    """生成 thumb / medium / webp 三份派生图，返回 variants 字典。"""
    s = get_settings()
    if not mime.startswith("image/") or mime == "image/svg+xml":
        return {}  # SVG 交给浏览器渲染，不做位图派生

    def _work() -> list[tuple[str, bytes, str]]:
        im = _open(data)
        _guard(im, len(data))
        im = ImageOps.exif_transpose(im)  # 修正手机照片方向
        out: list[tuple[str, bytes, str]] = []

        def encode(img: Image.Image, fmt: str, **kw) -> bytes:
            buf = io.BytesIO()
            save_img = img.convert("RGB") if fmt == "JPEG" else img
            save_img.save(buf, fmt, **kw)
            return buf.getvalue()

        # 缩略图（列表用）
        thumb = im.copy()
        thumb.thumbnail((s.IMAGE_THUMB_WIDTH, s.IMAGE_THUMB_WIDTH), Image.LANCZOS)
        out.append(("thumb", encode(thumb, "WEBP", quality=s.IMAGE_WEBP_QUALITY), "image/webp"))

        # 中等尺寸（编辑器预览用）
        if im.width > s.IMAGE_MEDIUM_WIDTH:
            med = im.copy()
            med.thumbnail((s.IMAGE_MEDIUM_WIDTH, s.IMAGE_MEDIUM_WIDTH), Image.LANCZOS)
            out.append(("medium", encode(med, "WEBP", quality=s.IMAGE_WEBP_QUALITY), "image/webp"))

        # WebP 版原尺寸（导出时节省体积）
        out.append(("webp", encode(im, "WEBP", quality=s.IMAGE_WEBP_QUALITY), "image/webp"))
        return out

    results = await asyncio.to_thread(_work)
    variants: dict[str, dict] = {}
    for name, blob, ctype in results:
        key, digest = await save_content_addressed(blob, ".webp")
        variants[name] = {
            "key": key,
            "sha256": digest,
            "size": len(blob),
            "mime": ctype,
        }
    return variants


async def crop(data: bytes, spec: CropSpec) -> tuple[bytes, str]:
    """按裁切规格产出新图。返回 (bytes, mime)。原图保持不变。"""
    if spec.mode == "original":
        return data, "image/webp"

    def _work() -> bytes:
        im = _open(data)
        _guard(im, len(data))
        im = ImageOps.exif_transpose(im)

        if spec.mode == "card":
            tw, th = CARD_PRESETS.get(spec.preset, CARD_PRESETS["poker"])
        else:
            tw, th = spec.width or im.width, spec.height or im.height
        tw, th = max(1, int(tw)), max(1, int(th))
        target_ratio = tw / th

        # 先按 zoom 取一个居中于焦点的窗口，保持目标比例
        w, h = im.size
        crop_w = w / max(spec.zoom, 1.0)
        crop_h = crop_w / target_ratio
        if crop_h > h:
            crop_h = h
            crop_w = crop_h * target_ratio

        cx = min(max(spec.focus_x, 0.0), 1.0) * w
        cy = min(max(spec.focus_y, 0.0), 1.0) * h
        left = min(max(cx - crop_w / 2, 0), max(w - crop_w, 0))
        top = min(max(cy - crop_h / 2, 0), max(h - crop_h, 0))

        cropped = im.crop((int(left), int(top), int(left + crop_w), int(top + crop_h)))
        cropped = cropped.resize((tw, th), Image.LANCZOS)
        return encode_webp(cropped)

    def encode_webp(img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB").save(
            buf, "WEBP", quality=get_settings().IMAGE_WEBP_QUALITY
        )
        return buf.getvalue()

    blob = await asyncio.to_thread(_work)
    return blob, "image/webp"
