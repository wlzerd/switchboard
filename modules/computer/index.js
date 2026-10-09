// 화면 제어 모듈. 에이전트가 이 컴퓨터의 화면을 보고(스크린샷) 마우스 · 키보드로 조작합니다 (Claude 컴퓨터 사용 도구 묶음).
// 서버는 화면 제어 권한 · 기본 금지 조항 · 승인을 거친 동작만 이 모듈에 넘깁니다.
// 비상 정지: 마우스를 화면 왼쪽 위 모서리로 옮기면 다음 동작부터 멈춥니다.
import { ACTIONS, ComputerStopped, INPUT_ACTIONS, fromScreen, geometry, parseSettings, validateAction } from './lib.js';

/** 운영체제별 화면 · 입력 구현을 받아 모듈을 만듭니다 (시험에서는 가짜 구현을 넣음). */
export function makeComputer(pickBackend) {
  let ctx = null;
  let settings = null;
  let backend = null;
  /** 마지막으로 모델에게 보여 준 스크린샷의 좌표계. 모델의 좌표는 늘 이 기준입니다. */
  let geo = null;

  async function refreshGeometry() {
    const s = await backend.screenSize(ctx);
    geo = geometry(s.w, s.h, settings.maxEdge);
    return geo;
  }

  return {
    async activate(context) {
      ctx = context;
      settings = parseSettings(ctx.env);
      backend = pickBackend();
      await backend.check(ctx);
      await refreshGeometry();
      ctx.log.info(`화면 ${geo.screen.w}×${geo.screen.h} · 모델에게 보내는 스크린샷 ${geo.shot.w}×${geo.shot.h}`);
    },

    async deactivate() {
      geo = null;
    },

    computer: {
      async run(action, input) {
        if (!ACTIONS.includes(action)) throw new Error(`알 수 없는 화면 동작 '${action}'입니다.`);
        // 화면을 볼 때마다 크기를 다시 재서(해상도 · 모니터 변경) 그 스크린샷 기준으로 좌표를 맞춥니다.
        if (action === 'screenshot' || geo === null) await refreshGeometry();
        const req = validateAction(action, input, geo);
        switch (req.kind) {
          case 'screenshot':
            return { image: await backend.screenshot(ctx, geo) };
          case 'zoom':
            return { image: await backend.zoom(ctx, geo, req.rect) };
          case 'cursor': {
            const [x, y] = await backend.cursor(ctx);
            const [sx, sy] = fromScreen(x, y, geo);
            return { text: `X=${sx},Y=${sy}` };
          }
          case 'wait':
            await new Promise((resolve) => setTimeout(resolve, req.duration * 1000));
            return { text: 'OK' };
          default:
            if (!INPUT_ACTIONS.has(action)) throw new Error(`입력 동작이 아닌 '${action}'을(를) 실행하려 했습니다.`);
            await backend.act(ctx, req);
            return { text: 'OK' };
        }
      },
    },
  };
}

async function platformBackend() {
  if (process.platform === 'darwin') return import('./mac.js');
  if (process.platform === 'linux') return import('./linux.js');
  return null;
}

const loaded = await platformBackend();
const computer = makeComputer(() => {
  if (!loaded) throw new Error(`화면 제어는 macOS 와 Linux(X11)에서만 됩니다. 지금 운영체제: ${process.platform}`);
  return loaded;
});

export { ComputerStopped };

export default {
  activate: computer.activate,
  deactivate: computer.deactivate,
  computer: computer.computer,
  tools: {},
};
