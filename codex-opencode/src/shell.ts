import fs from 'node:fs';
import path from 'node:path';
import type { ShellSpec } from './types.js';

// Compatibility reference: OpenCode v1.18.30 packages/core/src/shell.ts.
function file(value:string){try{if(process.platform!=='win32')fs.accessSync(value,fs.constants.X_OK);return fs.statSync(value).isFile();}catch{return false;}}
function which(name:string):string|undefined {
  if(path.isAbsolute(name))return file(name)?name:undefined;
  const extensions=process.platform==='win32'&&!path.extname(name)?(process.env.PATHEXT??'.EXE;.CMD;.BAT;.COM').split(';'):[''];
  for(const directory of (process.env.PATH??'').split(path.delimiter))for(const extension of extensions){const candidate=path.resolve(directory.replace(/^"|"$/g,''),name+extension);if(file(candidate))return candidate;}
}
function gitBash(){
  if(process.env.OPENCODE_GIT_BASH_PATH)return process.env.OPENCODE_GIT_BASH_PATH;
  const git=which('git');if(!git)return;
  const bash=path.resolve(git,'..','..','bin','bash.exe');return file(bash)?bash:undefined;
}
function shellName(executable:string){return path.basename(executable).replace(/\.exe$/i,'').toLowerCase();}
export function verificationShell(override?:ShellSpec,configured?:string):ShellSpec {
  if(override)return override;
  let preferred=configured??process.env.SHELL;
  if(process.platform==='win32'&&preferred&&(preferred.startsWith('/')||shellName(preferred)==='bash'))preferred=gitBash()??preferred;
  const selected=preferred&&which(preferred);
  const executable=selected??(process.platform==='win32'?(which('pwsh')??which('powershell')??gitBash()??process.env.COMSPEC??process.env.ComSpec??'cmd.exe'):(process.platform==='darwin'?'/bin/zsh':which('bash')??'/bin/sh'));
  const name=shellName(executable);
  return {executable,args:name==='cmd'?['/d','/s','/c']:['powershell','pwsh'].includes(name)?['-NoProfile','-Command']:['bash','zsh'].includes(name)?['-l','-c']:['-c'],baseline:true};
}
export function verificationInvocation(shell:ShellSpec,command:string,directory:string):string[] {
  if(!shell.baseline)return [...shell.args,command];
  const name=shellName(shell.executable);
  if(name==='bash'||name==='zsh') {
    const setup=name==='bash'?'shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true':'[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true\n[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true';
    return [...shell.args,`${setup}\ncd -- "$1"\neval ${JSON.stringify(command)}`,'opencode',directory];
  }
  // PowerShell otherwise maps a native nonzero status to 1. Preserve the
  // observed last native exit code while retaining failures of cmdlets too.
  if(name==='powershell'||name==='pwsh')return [...shell.args.slice(0,-1),'-EncodedCommand',Buffer.from(`${command}\n$delegateSuccess=$?; if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}; if(-not $delegateSuccess){exit 1}`,'utf16le').toString('base64')];
  return [...shell.args,command];
}
