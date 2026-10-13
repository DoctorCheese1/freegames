import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {UPDATE_FILES,repository} from './updater.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const sha=process.env.GITHUB_SHA;
if(!/^[a-f0-9]{40}$/.test(sha||''))throw new Error('Missing commit SHA');
await mkdir('release',{recursive:true});
const manifest={repository,version:pkg.version,sha,files:{}};
for(const file of UPDATE_FILES){
 const asset=file==='.gitignore'?'gitignore.txt':file;
 const bytes=await readFile(file);
 await copyFile(file,'release/'+asset);
 manifest.files[file]={url:'https://github.com/'+repository+'/releases/download/v'+pkg.version+'/'+asset,sha256:createHash('sha256').update(bytes).digest('hex')};
}
await writeFile('release/latest.json',JSON.stringify(manifest,null,2));
