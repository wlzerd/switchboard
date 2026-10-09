// 화면 제어 모듈의 macOS 쪽: screencapture · sips(기본 제공)로 화면을 찍고, mac-input.js(JXA)로 입력합니다.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerStopped, STOP_MESSAGE, fitInto, macRequest, parseSipsSize } from './lib.js';

const SCRIPT = fileURLToPath(new URL('./mac-input.js', import.meta.url));
const OSASCRIPT = '/usr/bin/osascript';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const SIPS = '/usr/bin/sips';

const ACCESSIBILITY = 'macOS 손쉬운 사용 권한이 없어 마우스와 키보드를 움직일 수 없습니다. 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 Switchboard 를 실행한 앱(터미널 · iTerm 등)을 켠 뒤 모듈을 다시 시작하세요.';
const SCREEN_RECORDING = '화면을 찍지 못했습니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹화에서 Switchboard 를 실행한 앱(터미널 · iTerm 등)을 켠 뒤 모듈을 다시 시작하세요.';

function run(file, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message).trim().slice(0, 300);
        reject(Object.assign(new Error(`${path.basename(file)} 실행 실패: ${why}`), { code: err.code }));
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function jxa(req, timeoutMs) {
  const out = await run(OSASCRIPT, ['-l', 'JavaScript', SCRIPT, JSON.stringify(req)], timeoutMs);
  try {
    return JSON.parse(out.trim() || '{}');
  } catch {
    throw new Error(`입력 스크립트가 알 수 없는 결과를 돌려줬습니다: ${out.trim().slice(0, 200)}`);
  }
}

export async function check() {
  const info = await jxa({ op: 'info' });
  if (!info.trusted) throw new Error(ACCESSIBILITY);
}

export async function screenSize() {
  const info = await jxa({ op: 'info' });
  return { w: info.w, h: info.h };
}

export async function cursor() {
  const r = await jxa({ op: 'cursor' });
  return r.cursor;
}

async function capture(args, raw) {
  await fs.rm(raw, { force: true });
  try {
    await run(SCREENCAPTURE, [...args, raw]);
  } catch (err) {
    throw new Error(`${SCREEN_RECORDING} (원인: ${err.message})`);
  }
  try {
    await fs.access(raw);
  } catch {
    throw new Error(SCREEN_RECORDING);
  }
}

async function toJpeg(raw, out, w, h, quality) {
  await run(SIPS, ['-z', String(h), String(w), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), raw, '--out', out]);
  return { data: (await fs.readFile(out)).toString('base64'), mediaType: 'image/jpeg' };
}

/** 주 화면 전체를 찍어 모델이 보는 크기(geo.shot)로 줄입니다. */
export async function screenshot(ctx, geo) {
  const raw = path.join(ctx.dataDir, 'screen.png');
  await capture(['-x', '-m', '-t', 'png'], raw);
  return toJpeg(raw, path.join(ctx.dataDir, 'screen.jpg'), geo.shot.w, geo.shot.h, 75);
}

/** 화면의 한 영역(포인트 좌표)을 원래 해상도로 찍고, 평소 스크린샷 크기 안에 맞춥니다. */
export async function zoom(ctx, geo, rect) {
  const raw = path.join(ctx.dataDir, 'zoom.png');
  await capture(['-x', `-R${rect.x},${rect.y},${rect.w},${rect.h}`, '-t', 'png'], raw);
  const size = parseSipsSize(await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', raw]));
  const fit = fitInto(size.w, size.h, geo.shot.w, geo.shot.h);
  return toJpeg(raw, path.join(ctx.dataDir, 'zoom.jpg'), fit.w, fit.h, 85);
}

export async function act(ctx, req) {
  const longest = req.kind === 'hold' ? req.duration * 1000 : req.kind === 'type' ? 5000 : 0;
  const r = await jxa({ ...macRequest(req), failsafe: true }, 20_000 + longest);
  if (r.untrusted) throw new Error(ACCESSIBILITY);
  if (r.stopped) throw new ComputerStopped(STOP_MESSAGE);
}
