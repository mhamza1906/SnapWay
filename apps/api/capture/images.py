"""Decode, verify and derive capture images with Pillow (no other image dependency)."""

import hashlib
import io
from dataclasses import dataclass

from django.conf import settings
from PIL import Image, ImageOps, UnidentifiedImageError

FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
}
DISPLAY_LONG_EDGE = 2560
DISPLAY_QUALITY = 90
THUMBNAIL_EDGE = 320
THUMBNAIL_QUALITY = 82
MAX_PIXELS = 80_000_000  # well above phone sensors; refuses decompression bombs


class ImageRejected(ValueError):
    pass


@dataclass
class Rendition:
    data: bytes
    width: int
    height: int
    content_type: str = "image/jpeg"


@dataclass
class ProcessedImage:
    original: bytes
    sha256: str
    content_type: str
    extension: str
    raw_width: int
    raw_height: int
    width: int  # upright
    height: int
    orientation: int
    display: Rendition
    thumbnail: Rendition


def max_upload_bytes():
    return getattr(settings, "CAPTURE_MAX_UPLOAD_BYTES", 20 * 1024 * 1024)


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _jpeg(image, quality, **options):
    if image.mode not in ("RGB", "L"):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=quality, optimize=True, **options)
    return Rendition(buffer.getvalue(), image.width, image.height)


def process(data):
    """Validate the bytes as a JPEG/PNG/WebP photo and build display/thumbnail copies."""
    if not data:
        raise ImageRejected("Empty image")
    if len(data) > max_upload_bytes():
        raise ImageRejected("Image exceeds the upload size limit")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            image_format = probe.format
            if image_format not in FORMATS:
                raise ImageRejected("Image must be JPEG, PNG or WebP")
            if probe.width * probe.height > MAX_PIXELS:
                raise ImageRejected("Image has too many pixels")
            probe.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            raw_width, raw_height = image.size
            orientation = image.getexif().get(0x0112, 1)
            upright = ImageOps.exif_transpose(image)
    except ImageRejected:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise ImageRejected("Image could not be decoded") from None

    display_image = upright.copy()
    if max(display_image.size) > DISPLAY_LONG_EDGE:
        display_image.thumbnail((DISPLAY_LONG_EDGE, DISPLAY_LONG_EDGE), Image.Resampling.LANCZOS)
    # 4:4:4 chroma keeps small sign lettering crisp.
    display = _jpeg(display_image, DISPLAY_QUALITY, subsampling=0)
    thumb_image = upright.copy()
    thumb_image.thumbnail((THUMBNAIL_EDGE, THUMBNAIL_EDGE), Image.Resampling.LANCZOS)
    thumbnail = _jpeg(thumb_image, THUMBNAIL_QUALITY)
    content_type, extension = FORMATS[image_format]
    return ProcessedImage(
        original=data,
        sha256=sha256_hex(data),
        content_type=content_type,
        extension=extension,
        raw_width=raw_width,
        raw_height=raw_height,
        width=upright.width,
        height=upright.height,
        orientation=int(orientation) if isinstance(orientation, int) else 1,
        display=display,
        thumbnail=thumbnail,
    )
