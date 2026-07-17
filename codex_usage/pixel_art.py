"""Deterministic, dependency-free pixel-art renderer used by bundled characters."""
from __future__ import annotations

import binascii
import struct
import zlib
from dataclasses import dataclass

FRAME = 256
FRAMES = 4
SHEET_WIDTH = FRAME * FRAMES


@dataclass(frozen=True)
class CharacterDefinition:
    id: str
    name: str
    personality: str
    tags: tuple[str, ...]
    colors: tuple[tuple[int, int, int, int], tuple[int, int, int, int], tuple[int, int, int, int]]
    traits: tuple[str, ...]


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)


def encode_png_rgba(width: int, height: int, rgba: bytes) -> bytes:
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA size does not match dimensions")
    rows = b"".join(b"\0" + rgba[index:index + width * 4] for index in range(0, len(rgba), width * 4))
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + _chunk(b"IDAT", zlib.compress(rows, 9)) + _chunk(b"IEND", b"")


class Canvas:
    def __init__(self, width: int = 64, height: int = 64):
        self.width, self.height = width, height
        self.pixels = [(0, 0, 0, 0)] * (width * height)

    def dot(self, x: int, y: int, color):
        if 0 <= x < self.width and 0 <= y < self.height:
            self.pixels[y * self.width + x] = color

    def rect(self, x: int, y: int, width: int, height: int, color):
        for py in range(y, y + height):
            for px in range(x, x + width): self.dot(px, py, color)

    def oval(self, cx: int, cy: int, rx: int, ry: int, color):
        for y in range(cy - ry, cy + ry + 1):
            for x in range(cx - rx, cx + rx + 1):
                if ((x - cx) * (x - cx)) * ry * ry + ((y - cy) * (y - cy)) * rx * rx <= rx * rx * ry * ry:
                    self.dot(x, y, color)

    def line(self, x0: int, y0: int, x1: int, y1: int, color):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for step in range(steps + 1):
            self.dot(round(x0 + (x1 - x0) * step / steps), round(y0 + (y1 - y0) * step / steps), color)

    def png(self) -> bytes:
        raw = bytearray()
        for color in self.pixels:
            raw.extend(color * 16)  # each logical dot becomes a 4px horizontal run
        scaled = bytearray()
        row = 64 * 4 * 4
        for y in range(64):
            line = raw[y * row:(y + 1) * row]
            for _ in range(4): scaled.extend(line)
        return encode_png_rgba(FRAME, FRAME, bytes(scaled))


def _feature(canvas: Canvas, trait: str, main, accent, dark, shift: int):
    # Small declarative motifs. Combining them produces recognisably different fan-art silhouettes.
    if trait == "ears_long":
        canvas.oval(23 + shift, 17, 3, 12, main); canvas.oval(41 + shift, 17, 3, 12, main)
        canvas.rect(21 + shift, 8, 4, 3, dark); canvas.rect(39 + shift, 8, 4, 3, dark)
    elif trait == "ears_round":
        canvas.oval(22 + shift, 20, 6, 7, main); canvas.oval(42 + shift, 20, 6, 7, main)
    elif trait == "tail_lightning":
        canvas.line(45 + shift, 42, 56 + shift, 38, main); canvas.line(56 + shift, 38, 52 + shift, 44, main); canvas.line(52 + shift, 44, 61 + shift, 45, main)
    elif trait == "tail_long": canvas.line(43 + shift, 43, 58 + shift, 52, main); canvas.oval(59 + shift, 53, 3, 3, accent)
    elif trait == "flame":
        canvas.oval(53 + shift, 44, 5, 7, accent); canvas.oval(53 + shift, 42, 2, 4, (255, 235, 80, 255))
    elif trait == "wings":
        canvas.oval(17 + shift, 36, 11, 7, accent); canvas.oval(47 + shift, 36, 11, 7, accent)
    elif trait == "shell": canvas.oval(32 + shift, 41, 15, 13, dark); canvas.oval(32 + shift, 41, 11, 10, accent)
    elif trait == "cannons": canvas.rect(13 + shift, 38, 10, 4, dark); canvas.rect(41 + shift, 38, 10, 4, dark)
    elif trait == "bulb": canvas.oval(32 + shift, 27, 14, 10, accent)
    elif trait == "flower":
        for x, y in ((24, 25), (32, 20), (40, 25), (27, 31), (37, 31)): canvas.oval(x + shift, y, 6, 5, accent)
        canvas.oval(32 + shift, 27, 4, 4, (255, 220, 80, 255))
    elif trait == "collar":
        for x in range(18, 48, 5): canvas.line(x + shift, 37, x + 2 + shift, 43, accent)
    elif trait == "fins": canvas.oval(18 + shift, 31, 8, 4, accent); canvas.oval(46 + shift, 31, 8, 4, accent)
    elif trait == "spikes":
        for x in range(18, 48, 6): canvas.line(x + shift, 34, x + 3 + shift, 27, accent)
    elif trait == "rings":
        for x, y in ((23, 29), (41, 29), (32, 43)): canvas.oval(x + shift, y, 3, 3, accent)
    elif trait == "gem": canvas.oval(32 + shift, 25, 3, 3, accent)
    elif trait == "wide": canvas.oval(32 + shift, 43, 19, 13, main)
    elif trait == "spiny":
        for x in range(18, 48, 6): canvas.line(x + shift, 34, x + 3 + shift, 27, dark)
    elif trait == "beak": canvas.oval(32 + shift, 33, 8, 4, accent)
    elif trait == "coin": canvas.oval(32 + shift, 25, 4, 4, accent)
    elif trait == "mask": canvas.rect(22 + shift, 29, 20, 4, dark)
    elif trait == "antennae": canvas.line(27 + shift, 22, 22 + shift, 14, accent); canvas.line(37 + shift, 22, 42 + shift, 14, accent)
    elif trait == "penguin": canvas.oval(32 + shift, 40, 13, 17, dark); canvas.oval(32 + shift, 42, 8, 11, (230, 240, 245, 255))
    elif trait == "owl": canvas.oval(32 + shift, 40, 16, 16, main); canvas.oval(32 + shift, 37, 5, 3, accent)
    elif trait == "fire_back":
        for x in range(21, 44, 5): canvas.oval(x + shift, 33, 3, 8, accent)
    elif trait == "hair":
        for x in range(18, 47, 5): canvas.line(x + shift, 20, x + 3 + shift, 30, dark)
    elif trait == "headband": canvas.rect(20 + shift, 25, 24, 3, accent)
    elif trait == "cloak": canvas.oval(32 + shift, 45, 17, 15, dark)


def render_frame(definition: CharacterDefinition, state: str, frame: int) -> bytes:
    main, accent, dark = definition.colors
    canvas = Canvas(); shift = (frame % 2) - (1 if state == "walk" else 0)
    body_y = 42 + (1 if state == "walk" and frame % 2 else 0)
    canvas.oval(32 + shift, body_y, 13, 15, main)
    canvas.oval(32 + shift, 29, 14, 12, main)
    for trait in definition.traits: _feature(canvas, trait, main, accent, dark, shift)
    eye = dark
    if state == "sleep": canvas.line(24 + shift, 30, 28 + shift, 30, eye); canvas.line(36 + shift, 30, 40 + shift, 30, eye)
    else:
        canvas.oval(26 + shift, 30, 2, 2, eye); canvas.oval(38 + shift, 30, 2, 2, eye)
    if state in {"worried", "critical", "confused"}: canvas.line(23 + shift, 26, 28 + shift, 25, eye); canvas.line(36 + shift, 25, 41 + shift, 26, eye)
    if state in {"happy", "celebrate", "wake"}: canvas.line(28 + shift, 35, 36 + shift, 35, accent)
    if state == "critical": canvas.rect(29 + shift, 18, 6, 3, (255, 80, 80, 255))
    if state == "cold": canvas.line(15 + shift, 20, 10 + shift, 15, accent)
    if state == "hot": canvas.oval(50 + shift, 22, 3, 5, accent)
    if state == "point": canvas.line(42 + shift, 40, 56 + shift, 30, dark)
    if state == "celebrate": canvas.line(20 + shift, 40, 12 + shift, 26, dark); canvas.line(44 + shift, 40, 52 + shift, 26, dark)
    if state == "dragging": canvas.rect(18 + shift, 51, 28, 3, dark)
    return canvas.png()


def render_sheet(definition: CharacterDefinition, state: str) -> bytes:
    frames = [render_frame(definition, state, frame) for frame in range(FRAMES)]
    # Decode our own fixed scanline layout and concatenate frames without external imaging libraries.
    raw_frames = [zlib.decompress(frame[41:-12]) for frame in frames]
    output = bytearray()
    row_len = 1 + FRAME * 4
    for y in range(FRAME):
        output.append(0)
        for raw in raw_frames: output.extend(raw[y * row_len + 1:(y + 1) * row_len])
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", SHEET_WIDTH, FRAME, 8, 6, 0, 0, 0)) + _chunk(b"IDAT", zlib.compress(bytes(output), 9)) + _chunk(b"IEND", b"")
