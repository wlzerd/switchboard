// 빈 모듈 템플릿. tools 의 키는 module.json 의 tools[].handler (없으면 name) 와 같아야 합니다.
// 템플릿으로 만들면 도구 이름 앞에 모듈 id 가 붙고(my_mod_echo), handler 에 원래 함수 이름(echo)이 들어갑니다.
export default {
  async activate(ctx) {
    ctx.log.info('모듈이 시작되었습니다');
  },

  tools: {
    async echo(input) {
      return `받은 내용: ${input.text}`;
    },
  },
};
