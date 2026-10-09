// 화면 제어 모듈의 Linux(X11) 쪽: xdotool 로 입력하고 ImageMagick import 로 화면을 찍습니다.
// 두 프로그램은 함께 묶어 배포하지 않으며, 서버 컴퓨터에 설치되어 있어야 합니다.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ComputerStopped, STOP_MESSAGE, failsafeHit, fitInto, parseDisplayGeometry, parseMouseLocation, xdotoolArgs } from './lib.js';

function run(ctx, file, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const env = { PATH: ctx.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', DISPLAY: ctx.env.DISPLAY ?? '', ...(ctx.env.XAUTHORITY ? { XAUTHORITY: ctx.env.XAUTHORITY } : {}) };
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error(file === 'xdotool' ? 'xdotool 이 없습니다. 서버 컴퓨터에 설치하세요 (예: sudo apt install xdotool).' : 'ImageMagick 의 import 가 없습니다. 서버 컴퓨터에 설치하세요 (예: sudo apt install imagemagick).'));
          return;
        }
        reject(new Error(`${file} 실행 실패: ${String(stderr || err.message).trim().slice(0, 300)}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function check(ctx) {
  if (!ctx.env.DISPLAY) {
    if (ctx.env.WAYLAND_DISPLAY) throw new Error('Wayland 세션은 지원하지 않습니다. X11 세션이나 가상 화면(Xvfb)에서 서버를 실행하고 DISPLAY 를 넣으세요.');
    throw new Error('DISPLAY 가 없습니다. 화면이 있는 X11 세션에서 서버를 실행하거나, 가상 화면(예: Xvfb :99)을 띄우고 .env 에 DISPLAY=:99 를 넣으세요.');
  }
  await run(ctx, 'xdotool', ['version']);
  await run(ctx, 'import', ['-version']);
}

export async function screenSize(ctx) {
  return parseDisplayGeometry(await run(ctx, 'xdotool', ['getdisplaygeometry']));
}

export async function cursor(ctx) {
  return parseMouseLocation(await run(ctx, 'xdotool', ['getmouselocation', '--shell']));
}

async function shot(ctx, args, file) {
  await fs.rm(file, { force: true });
  await run(ctx, 'import', [...args, `jpeg:${file}`]);
  return { data: (await fs.readFile(file)).toString('base64'), mediaType: 'image/jpeg' };
}

export async function screenshot(ctx, geo) {
  return shot(ctx, ['-window', 'root', '-resize', `${geo.shot.w}x${geo.shot.h}!`, '-quality', '75'], path.join(ctx.dataDir, 'screen.jpg'));
}

export async function zoom(ctx, geo, rect) {
  const fit = fitInto(rect.w, rect.h, geo.shot.w, geo.shot.h);
  return shot(ctx, ['-window', 'root', '-crop', `${rect.w}x${rect.h}+${rect.x}+${rect.y}`, '+repage', '-resize', `${fit.w}x${fit.h}!`, '-quality', '85'], path.join(ctx.dataDir, 'zoom.jpg'));
}

export async function act(ctx, req) {
  const [x, y] = await cursor(ctx);
  if (failsafeHit(x, y)) throw new ComputerStopped(STOP_MESSAGE);
  const longest = req.kind === 'hold' ? req.duration * 1000 : req.kind === 'type' ? req.text.length * 30 : 0;
  await run(ctx, 'xdotool', xdotoolArgs(req), 20_000 + longest);
}
