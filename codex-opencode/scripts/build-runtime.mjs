import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function packageRoot(from,name) {
  const require=createRequire(path.join(from,'package.json'));
  for(const directory of require.resolve.paths(name)??[]) {
    const file=path.join(directory,name,'package.json');
    if(fs.existsSync(file))return fs.realpathSync.native(path.dirname(file));
  }
}
export function buildRuntime(source) {
  const output=path.join(source,'dist','runtime_modules');fs.rmSync(output,{recursive:true,force:true});
  const entry=packageRoot(source,'@codex-opencode/claude-runtime');
  if(!entry)throw new Error('Install the isolated Claude runtime package before building.');
  const copied=[];
  const copy=(from,to,ancestors=new Set())=>{
    const info=JSON.parse(fs.readFileSync(path.join(from,'package.json')));
    if(ancestors.has(from))throw new Error(`Runtime dependency cycle at ${info.name}`);
    fs.cpSync(from,to,{recursive:true,dereference:true,filter:file=>path.basename(file)!=='node_modules'&&!file.endsWith('.log')});
    copied.push({name:info.name,version:info.version,path:path.relative(output,to)});
    const next=new Set([...ancestors,from]);
    for(const name of [...new Set([...Object.keys(info.dependencies??{}),...Object.keys(info.peerDependencies??{}),...Object.keys(info.optionalDependencies??{})])].sort()) {
      if(name.startsWith('@anthropic-ai/claude-agent-sdk-')&&name!==`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`)continue;
      const dependency=packageRoot(from,name);
      if(!dependency) {
        if(info.optionalDependencies?.[name]||info.peerDependenciesMeta?.[name]?.optional)continue;
        throw new Error(`Required runtime dependency is missing: ${info.name} -> ${name}`);
      }
      copy(dependency,path.join(to,'node_modules',name),next);
    }
  };
  copy(entry,path.join(output,'@codex-opencode','claude-runtime'));
  fs.writeFileSync(path.join(source,'dist','runtime-manifest.json'),JSON.stringify({packages:copied},null,2));
}
