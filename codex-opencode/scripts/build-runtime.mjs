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
  const copied=[],locations=new Map();
  function resolved(parent,name) {
    for(let directory=parent;directory&&directory!==output;directory=path.dirname(directory)) {
      const candidate=path.join(directory,'node_modules',name);if(locations.has(candidate))return candidate;
    }
    const candidate=path.join(output,name);return locations.has(candidate)?candidate:undefined;
  }
  const copy=(from,parent)=>{
    const info=JSON.parse(fs.readFileSync(path.join(from,'package.json')));
    const existing=parent?resolved(parent,info.name):undefined;
    if(existing&&locations.get(existing)===from)return;
    // Share the same installed package; conflicting versions/peer graphs get
    // a nearer node_modules entry, retaining normal Node resolution semantics.
    const to=existing?path.join(parent,'node_modules',info.name):path.join(output,info.name);
    if(locations.has(to))throw new Error(`Conflicting runtime placement for ${info.name}`);
    locations.set(to,from);
    fs.cpSync(from,to,{recursive:true,dereference:true,mode:fs.constants.COPYFILE_FICLONE,filter:file=>path.basename(file)!=='node_modules'&&!file.endsWith('.log')});
    copied.push({name:info.name,version:info.version,path:path.relative(output,to)});
    for(const name of [...new Set([...Object.keys(info.dependencies??{}),...Object.keys(info.peerDependencies??{}),...Object.keys(info.optionalDependencies??{})])].sort()) {
      if(name.startsWith('@anthropic-ai/claude-agent-sdk-')&&name!==`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`)continue;
      const dependency=packageRoot(from,name);
      if(!dependency) {
        if(info.optionalDependencies?.[name]||info.peerDependenciesMeta?.[name]?.optional)continue;
        throw new Error(`Required runtime dependency is missing: ${info.name} -> ${name}`);
      }
      copy(dependency,to);
    }
  };
  copy(entry);
  fs.writeFileSync(path.join(source,'dist','runtime-manifest.json'),JSON.stringify({packages:copied},null,2));
}
