"""最小 PDF 读取器：按 xref 精确解析本生成器写出的结构，供自检核对页面、图像与 OutputIntent。"""
from __future__ import annotations

import re
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image


@dataclass
class PdfStreamObject:
    object_id: int
    dictionary: bytes
    payload: bytes
    decoded: bytes = b""

    def number(self, key: str, default: float = 0.0) -> float:
        match = re.search(rb"/" + key.encode("ascii") + rb" ([\d.\-]+)", self.dictionary)
        return float(match.group(1)) if match else default


@dataclass
class PageInfo:
    object_id: int
    media_box: tuple[float, float, float, float]
    resources_id: int
    contents_id: int
    operations: list[tuple[str, float, float, float, float]] = field(default_factory=list)
    xobjects: dict[str, int] = field(default_factory=dict)


def _png_unfilter(data: bytes, columns: int, colors: int, bpc: int = 8) -> bytes:
    if bpc != 8:
        raise ValueError("只支持 8 位样本")
    row_bytes = columns * colors
    out = bytearray()
    previous = bytearray(row_bytes)
    pos = 0
    while pos < len(data):
        method = data[pos]
        pos += 1
        row = bytearray(data[pos:pos + row_bytes])
        pos += row_bytes
        if method == 0:
            pass
        elif method == 2:
            for i in range(row_bytes):
                row[i] = (row[i] + previous[i]) & 0xFF
        elif method == 1:
            for i in range(row_bytes):
                left = row[i - colors] if i >= colors else 0
                row[i] = (row[i] + left) & 0xFF
        else:
            raise ValueError(f"不支持的 PNG 行滤波：{method}")
        out += row
        previous = row
    return bytes(out)


class PdfDocument:
    def __init__(self, path: "str | Path"):
        self.path = Path(path)
        self.raw = self.path.read_bytes()
        self.objects: dict[int, bytes] = {}
        self.streams: dict[int, PdfStreamObject] = {}
        self.root_id = 0
        self.pages: list[PageInfo] = []
        self.images: dict[int, Image.Image] = {}
        self._load_xref()
        self._load_pages()
        self._load_images()

    # --- 结构 ---
    def _load_xref(self) -> None:
        match = re.search(rb"startxref\s+(\d+)", self.raw)
        if not match:
            raise ValueError("缺少 startxref，不是本生成器写出的 PDF")
        section = self.raw[int(match.group(1)):]
        header = re.match(rb"xref\n0 (\d+)\n", section)
        if not header:
            raise ValueError("xref 区段格式异常")
        count = int(header.group(1))
        pos = header.end()
        entries: list[tuple[int, bytes]] = []
        for _ in range(count):
            entry = section[pos:pos + 20]
            pos += 20
            entries.append((int(entry[0:10]), entry[17:18]))
        trailer = section[pos:pos + 400]
        root = re.search(rb"/Root (\d+) 0 R", trailer)
        self.root_id = int(root.group(1)) if root else 0
        for number, (offset, kind) in enumerate(entries):
            if kind != b"n":
                continue
            self._parse_object(number, offset)

    def _parse_object(self, number: int, offset: int) -> None:
        head = f"{number} 0 obj".encode("ascii")
        if not self.raw[offset:offset + len(head)] == head:
            raise ValueError(f"对象 {number} 的偏移量 {offset} 与对象头不匹配")
        pos = offset + len(head)
        while self.raw[pos:pos + 1] in b" \r\n\t":
            pos += 1
        if self.raw[pos:pos + 2] != b"<<":
            end = self.raw.index(b"endobj", pos)
            self.objects[number] = self.raw[pos:end].strip()
            return
        depth = 0
        index = pos
        while True:
            if self.raw[index:index + 2] == b"<<":
                depth += 1
                index += 2
            elif self.raw[index:index + 2] == b">>":
                depth -= 1
                index += 2
                if depth == 0:
                    break
            else:
                index += 1
        dictionary = self.raw[pos:index]
        self.objects[number] = dictionary
        rest = self.raw[index:]
        if not rest.startswith(b"\nstream\n"):
            return
        length = int(re.search(rb"/Length (\d+)", dictionary).group(1))
        payload = self.raw[index + 8:index + 8 + length]
        stream = PdfStreamObject(object_id=number, dictionary=dictionary, payload=payload)
        if b"/FlateDecode" in dictionary:
            stream.decoded = zlib.decompress(payload)
        else:
            stream.decoded = payload
        self.streams[number] = stream

    def _decoded_stream(self, object_id: int) -> bytes:
        stream = self.streams[object_id]
        if b"/Predictor 15" in stream.dictionary:
            colors = int(stream.number("Colors", 3))
            columns = int(stream.number("Columns", 1))
            return _png_unfilter(stream.decoded, columns, colors)
        return stream.decoded

    def catalog(self) -> bytes:
        return self.objects[self.root_id]

    def output_intents(self) -> list[dict]:
        match = re.search(rb"/OutputIntents \[(\d+) 0 R\]", self.catalog())
        if not match:
            return []
        intent_id = int(match.group(1))
        body = self.objects[int(intent_id)]
        identifier = re.search(rb"/OutputConditionIdentifier \(([^)]*)\)", body)
        profile = re.search(rb"/DestOutputProfile (\d+) 0 R", body)
        return [
            {
                "object_id": intent_id,
                "body": body.decode("latin1"),
                "identifier": identifier.group(1).decode("latin1") if identifier else "",
                "profile_id": int(profile.group(1)) if profile else 0,
            }
        ]

    def _load_pages(self) -> None:
        pages_id = int(re.search(rb"/Pages (\d+) 0 R", self.catalog()).group(1))
        kids = re.search(rb"/Kids \[([^\]]*)\]", self.objects[pages_id]).group(1)
        page_ids = [int(m.group(1)) for m in re.finditer(rb"(\d+) 0 R", kids)]
        for page_id in page_ids:
            body = self.objects[page_id]
            box = re.search(rb"/MediaBox \[([^\]]*)\]", body).group(1).split()
            media_box = tuple(float(value) for value in box)
            resources_id = int(re.search(rb"/Resources (\d+) 0 R", body).group(1))
            contents_id = int(re.search(rb"/Contents (\d+) 0 R", body).group(1))
            resources = self.objects[resources_id]
            xobjects: dict[str, int] = {}
            xobject_block = re.search(rb"/XObject <<([^>]*)>>", resources)
            if xobject_block:
                for name, ref in re.findall(rb"/(\w+) (\d+) 0 R", xobject_block.group(1)):
                    xobjects[name.decode("ascii")] = int(ref)
            page = PageInfo(object_id=page_id, media_box=media_box, resources_id=resources_id, contents_id=contents_id, xobjects=xobjects)
            content = self._decoded_stream(contents_id).decode("ascii")
            for match in re.finditer(
                r"q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm /(\w+) Do Q", content
            ):
                page.operations.append(
                    (match.group(5), float(match.group(3)), float(match.group(4)), float(match.group(1)), float(match.group(2)))
                )
            self.pages.append(page)

    def _load_images(self) -> None:
        for object_id, stream in self.streams.items():
            if b"/Subtype /Image" not in stream.dictionary:
                continue
            width = int(stream.number("Width"))
            height = int(stream.number("Height"))
            data = self._decoded_stream(object_id)
            if b"/DeviceRGB" in stream.dictionary:
                mode, expected = "RGB", width * height * 3
            elif b"/DeviceCMYK" in stream.dictionary:
                mode, expected = "CMYK", width * height * 4
            elif b"/DeviceGray" in stream.dictionary:
                mode, expected = "L", width * height
            else:
                continue
            if len(data) != expected:
                raise ValueError(f"图像对象 {object_id} 数据长度 {len(data)} != 期望 {expected}")
            self.images[object_id] = Image.frombytes(mode, (width, height), data)

    # --- 派生信息 ---
    def icc_profile(self, object_id: int) -> bytes:
        return self._decoded_stream(object_id)
