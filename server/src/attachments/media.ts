/**
 * 첨부 파일의 종류 판단 · 그림 크기 읽기 · 안전한 파일 이름.
 * 종류는 브라우저가 알려 주는 형식이 아니라 내용의 앞 바이트로 정합니다.
 */
import path from 'node:path';
import type { AttachmentKind } from '../db/store.ts';

/** Claude API 그림 한도: 한 장에 base64 10MB(원본 약 7.5MB). 여유를 두고 원본 7MB */
export const IMAGE_MAX_BYTES = 7 * 1024 * 1024;
/** Claude API 그림 한도: 가로 · 세로 8000px */
export const IMAGE_MAX_EDGE = 8000;
/** 모델이 줄이지 않고 보는 긴 변. 화면에서 올리기 전에 이 크기로 줄여 전송량과 토큰을 아낍니다 */
export const IMAGE_SEND_EDGE = 2576;
/** 글로 보내는 텍스트 파일 크기. 넘으면 작업 폴더에만 두고 경로를 알려 줍니다 */
export const TEXT_INLINE_MAX = 200_000;
const NAME_MAX = 120;

export interface Detected {
  kind: AttachmentKind;
  mediaType: string;
  width: number | null;
  height: number | null;
}

const EXT_TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.hwp': 'application/x-hwp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const startsWith = (buf: Buffer, bytes: readonly number[], at = 0): boolean => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, at: number, s: string): boolean => buf.length >= at + s.length && buf.toString('latin1', at, at + s.length) === s;

/** 내용 앞부분으로 본 그림 형식 (Claude 가 받는 네 가지만). SVG 는 스크립트가 들 수 있어 그림으로 보지 않습니다 */
export function imageType(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(buf, 0, 'GIF87a') || ascii(buf, 0, 'GIF89a')) return 'image/gif';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp';
  return null;
}

/**
 * 그림의 가로 · 세로. 머리 부분만 읽고, 읽지 못하면 null.
 * JPEG 는 표식(marker)을 따라가며 SOF 를 찾습니다 (표식마다 앞으로만 나아가므로 반드시 끝남).
 */
export function imageSize(buf: Buffer, type: string): { width: number; height: number } | null {
  try {
    if (type === 'image/png') {
      if (buf.length < 24 || !ascii(buf, 12, 'IHDR')) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === 'image/gif') {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (type === 'image/webp') {
      if (ascii(buf, 12, 'VP8 ') && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (ascii(buf, 12, 'VP8L') && buf.length >= 25) {
        const b1 = buf[22] as number;
        const b2 = buf[23] as number;
        const b3 = buf[24] as number;
        const b0 = buf[21] as number;
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (ascii(buf, 12, 'VP8X') && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1] as number;
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        // 길이가 없는 표식 (SOI · EOI · RST · TEM)
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if (marker === 0xd9) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** UTF-8 글자로 읽히고 NUL 이 없으면 텍스트 */
export function textOf(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function detect(name: string, buf: Buffer): Detected {
  const img = imageType(buf);
  if (img) {
    const size = imageSize(buf, img);
    return { kind: 'image', mediaType: img, width: size?.width ?? null, height: size?.height ?? null };
  }
  if (ascii(buf, 0, '%PDF-')) return { kind: 'pdf', mediaType: 'application/pdf', width: null, height: null };
  const ext = path.extname(name).toLowerCase();
  if (buf.length <= TEXT_INLINE_MAX && ext !== '.svg' && textOf(buf) !== null) return { kind: 'text', mediaType: 'text/plain', width: null, height: null };
  return { kind: 'file', mediaType: EXT_TYPES[ext] ?? (textOf(buf.subarray(0, 4096)) !== null ? 'text/plain' : 'application/octet-stream'), width: null, height: null };
}

/**
 * 저장 · 표시용 파일 이름: 경로 부분과 제어 문자를 떼고, 파일 시스템에서 문제가 되는 글자는 _ 로 바꿉니다.
 * 길면 확장자를 살려 줄입니다. 쓸 수 있는 글자가 없으면 null.
 */
export function safeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  s = s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[. ]+$/, '');
  if (s === '') return null;
  if (s.length > NAME_MAX) {
    const ext = path.extname(s);
    const keep = ext.length > 0 && ext.length <= 16 ? ext : '';
    s = `${s.slice(0, NAME_MAX - keep.length).trimEnd()}${keep}`;
  }
  return s;
}

/** '1.2MB' 같은 크기 표시 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
