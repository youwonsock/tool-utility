export const hookKey='/<session-flags>/config.toml:pre_tool_use:0:0';
export const sentinel='cmd-argument-redirection.txt';
export const inputSentinel='cmd-argument-input.txt';
export const configFixture={state:{[hookKey]:{enabled:true,trusted_hash:`sha256:${'a'.repeat(64)}`}},
  ['key<>&|%^!()한글%AGENT_DELEGATION_CMD_SENTINEL%']:{value:`text <${inputSentinel} & echo unexpected>${sentinel} & rem`,
    characters:'<>&|%^!()한글 %AGENT_DELEGATION_CMD_SENTINEL% !AGENT_DELEGATION_CMD_SENTINEL!',quoted:'"C:\\tool dir\\node.exe" "C:\\한글\\hook.mjs"',list:[true,12,false]}};
export function decodeInlineToml(text) {
  let quoted=false,escaped=false,json='';
  for(const char of text){if(char==='"'&&!escaped)quoted=!quoted;json+=char==='='&&!quoted?':':char;escaped=char==='\\'&&!escaped;}
  return JSON.parse(json);
}
