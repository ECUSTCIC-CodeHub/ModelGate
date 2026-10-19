"""极简 PDF 写入器：图像 XObject、页面内容流、OutputIntent。

只做兑换券拼版需要的事：把已经 1:1 合成好的位图按毫米坐标贴到页面上，不重采样、不缩放。
输出对象里没有字体（可变层的文字已经栅格化进券图），所以 CMYK 版可以按 PDF/X-1a:2003 的结构书写。
"""
from __future__ import annotations

import hashlib
import zlib
from pathlib import Path

from PIL import Image, ImageChops

COLOR_SPACES = {
    "RGB": ("/DeviceRGB", 3),
    "CMYK": ("/DeviceCMYK", 4),
    "L": ("/DeviceGray", 1),
}


def png_up_predictor(image: Image.Image) -> bytes:
    """按 PNG Up 滤波预处理像素，配合 /Predictor 15 让大片平色压得更狠。"""
    colors = len(image.getbands())
    width, height = image.size
    row_bytes = width * colors
    raw = image.tobytes()
    wide = Image.frombuffer("L", (row_bytes, height), raw)
    previous = Image.new("L", (row_bytes, height), 0)
    if height > 1:
        previous.paste(wide.crop((0, 0, row_bytes, height - 1)), (0, 1))
    diff = ImageChops.subtract_modulo(wide, previous)
    data = diff.tobytes()
    return b"".join(b"\x02" + data[i:i + row_bytes] for i in range(0, len(data), row_bytes))


class PdfWriter:
    """对象 1 固定为 Pages、对象 2 固定为 Catalog，便于页面直接引用父节点。"""

    def __init__(self, media_box_pt: tuple[float, float], title: str, creator: str, subject: str = ""):
        self.width_pt, self.height_pt = media_box_pt
        self.title = title
        self.creator = creator
        self.subject = subject
        self._objects: list[bytes] = [b"", b""]
        self._pages: list[int] = []
        self._image_cache: dict[tuple, int] = {}
        self._resource_cache: dict[tuple, int] = {}
        self.output_intent: dict | None = None
        self.compression_level = 6
        self.unique_images = 0

    def _add_object(self, body: bytes) -> int:
        self._objects.append(body)
        return len(self._objects)

    def _add_stream(self, dictionary: str, data: bytes) -> int:
        body = f"<< {dictionary} /Length {len(data)} >>\nstream\n".encode("ascii") + data + b"\nendstream"
        return self._add_object(body)

    def add_image(self, image: Image.Image) -> int:
        mode = image.mode
        if mode not in COLOR_SPACES:
            raise ValueError(f"不支持的图像模式：{mode}")
        colorspace, colors = COLOR_SPACES[mode]
        width, height = image.size
        key = (mode, width, height, hashlib.sha1(image.tobytes()).hexdigest())
        cached = self._image_cache.get(key)
        if cached is not None:
            return cached
        filtered = png_up_predictor(image)
        payload = zlib.compress(filtered, self.compression_level)
        dictionary = (
            f"/Type /XObject /Subtype /Image /Width {width} /Height {height} "
            f"/ColorSpace {colorspace} /BitsPerComponent 8 /Filter /FlateDecode "
            f"/DecodeParms << /Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {width} >>"
        )
        object_id = self._add_stream(dictionary, payload)
        self._image_cache[key] = object_id
        self.unique_images += 1
        return object_id

    def set_output_intent(self, icc_bytes: bytes, identifier: str, info: str = "", registry: str = "", pdfx_version: str = "") -> None:
        compressed = zlib.compress(icc_bytes, 6)
        profile_id = self._add_stream("/N 4 /Filter /FlateDecode", compressed)
        self.output_intent = {
            "profile_id": profile_id,
            "identifier": identifier,
            "info": info,
            "registry": registry,
            "pdfx_version": pdfx_version,
        }

    def add_page(self, draws: list[tuple[int, float, float, float, float]]) -> int:
        """draws 为 (图像对象号, x_pt, y_pt, w_pt, h_pt)，按给定顺序绘制。"""
        names: dict[int, str] = {}
        entries: list[str] = []
        for object_id, _, _, _, _ in draws:
            if object_id not in names:
                names[object_id] = f"Im{len(names) + 1}"
                entries.append(f"/{names[object_id]} {object_id} 0 R")
        operations = [
            f"q {w:.4f} 0 0 {h:.4f} {x:.4f} {y:.4f} cm /{names[object_id]} Do Q"
            for object_id, x, y, w, h in draws
        ]
        content = zlib.compress("\n".join(operations).encode("ascii"), self.compression_level)
        resource_key = tuple(sorted(names.items()))
        resource_id = self._resource_cache.get(resource_key)
        if resource_id is None:
            resource_id = self._add_object(("<< /XObject << " + " ".join(entries) + " >> >>").encode("ascii"))
            self._resource_cache[resource_key] = resource_id
        content_id = self._add_stream("/Filter /FlateDecode", content)
        box = f"/MediaBox [0 0 {self.width_pt:.4f} {self.height_pt:.4f}] /TrimBox [0 0 {self.width_pt:.4f} {self.height_pt:.4f}] /BleedBox [0 0 {self.width_pt:.4f} {self.height_pt:.4f}]"
        page_id = self._add_object(
            f"<< /Type /Page /Parent 1 0 R {box} /Resources {resource_id} 0 R /Contents {content_id} 0 R >>".encode("ascii")
        )
        self._pages.append(page_id)
        return page_id

    def page_count(self) -> int:
        return len(self._pages)

    def save(self, path: "str | Path", pdf_version: str = "1.4", media_box_mm: tuple[float, float] | None = None) -> int:
        intent_id = 0
        if self.output_intent:
            intent = self.output_intent
            extra = ""
            if intent["registry"]:
                extra += f" /RegistryName ({_escape_text(intent['registry'])})"
            if intent["info"]:
                extra += f" /Info ({_escape_text(intent['info'])})"
            intent_id = self._add_object(
                (
                    "<< /Type /OutputIntent /S /GTS_PDFX"
                    f" /OutputConditionIdentifier ({_escape_text(intent['identifier'])})"
                    f"{extra} /DestOutputProfile {intent['profile_id']} 0 R >>"
                ).encode("utf-8")
            )
        kids = " ".join(f"{ref} 0 R" for ref in self._pages)
        self._objects[0] = f"<< /Type /Pages /Kids [{kids}] /Count {len(self._pages)} >>".encode("ascii")
        catalog = f"<< /Type /Catalog /Pages 1 0 R"
        if intent_id:
            catalog += f" /OutputIntents [{intent_id} 0 R]"
        catalog += " >>"
        self._objects[1] = catalog.encode("ascii")
        info = "<< /Title (" + _escape_text(self.title) + ") /Creator (" + _escape_text(self.creator) + ")"
        if self.subject:
            info += " /Subject (" + _escape_text(self.subject) + ")"
        if self.output_intent and self.output_intent["pdfx_version"]:
            info += " /GTS_PDFXVersion (" + _escape_text(self.output_intent["pdfx_version"]) + ")"
        info += " /Trapped /False >>"
        info_id = self._add_object(info.encode("utf-8"))

        output = bytearray()
        output += b"%PDF-" + pdf_version.encode("ascii") + b"\n"
        output += b"%\xe2\xe3\xcf\xd3\n"
        offsets: list[int] = []
        for index, body in enumerate(self._objects, start=1):
            offsets.append(len(output))
            output += f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
        xref_offset = len(output)
        total = len(self._objects)
        output += f"xref\n0 {total + 1}\n".encode("ascii")
        output += b"0000000000 65535 f \n"
        for offset in offsets:
            output += f"{offset:010d} 00000 n \n".encode("ascii")
        output += (
            f"trailer\n<< /Size {total + 1} /Root 2 0 R /Info {info_id} 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(output))
        return len(output)


def _escape_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
