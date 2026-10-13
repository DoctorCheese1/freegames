import { mkdir, readFile, writeFile, copyFile, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
export const ROOT=dirname(fileURLToPath(import.meta.url));
// Exact allowlist: configuration, state, logs and other local files are never downloaded.
export const UPDATE_FILES=['bot.mjs','run.mjs','updater.mjs','package.json','package-lock.json','README.md','Start-Bot.bat','test.mjs','.gitignore'];
export const repository='DoctorCheese1/freegames';
export async function api(path) {
 const headers={Accept:'application/vnd.github+json','User-Agent':'freegames-updater','X-GitHub-Api-Version':'2022-11-28'};
 if(process.env.GH_UPDATE_TOKEN)headers.Authorization=`Bearer ${process.env.GH_UPDATE_TOKEN.trim()}`;
 const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers,signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`GitHub update check failed (${response.status}). ${response.status===404?'For a private repository, set GH_UPDATE_TOKEN with read-only Contents access to freegames.':''}`);
 return response.json();
}
export function verifyBlob(bytes,sha) {
 const computed=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 if(computed!==sha)throw new Error('Update file hash mismatch');
}
export async function execute(command,args,cwd=ROOT) {
 await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,stdio:'inherit',shell:process.platform==='win32' && command==='npm'});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
 });
}
export async function download(url) {
 const parsed=new URL(url);
 if(parsed.protocol!=='https:' || parsed.hostname!=='github.com' || !parsed.pathname.startsWith('/'+repository+'/releases/'))throw new Error('Invalid release URL');
 const response=await fetch(url,{headers:{'User-Agent':'freegames-updater'},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('Release download failed ('+response.status+')');
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>2*1024*1024)throw new Error('Release file exceeds size limit');
 return bytes;
}
export async function stageUpdate() {
 // Public release assets need no GitHub token.
 const base='https://github.com/'+repository+'/releases/latest/download/';
 const manifest=JSON.parse((await download(base+'latest.json')).toString('utf8'));
 if(manifest.repository!==repository || !/^[a-f0-9]{40}$/.test(manifest.sha) || !/^\d+\.\d+\.\d+$/.test(manifest.version))throw new Error('Invalid release manifest');
 await writeFile(join(ROOT,'.update-status.json'),JSON.stringify({latest:manifest.version,checkedAt:new Date().toISOString(),result:'Release checked'},null,2));
 const sha=manifest.sha,marker=join(ROOT,'.update-version.json');
 const local=JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));
 if(local.version===manifest.version || (existsSync(marker) && JSON.parse(await readFile(marker,'utf8')).sha===sha))return null;
 const directory=join(ROOT,'.update-stage',sha);await mkdir(directory,{recursive:true});
 try {
  for(const file of UPDATE_FILES) {
   const asset=manifest.files?.[file];
   if(!asset || !/^[a-f0-9]{64}$/.test(asset.sha256))throw new Error('Missing release file '+file);
   const bytes=await download(asset.url);
   if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('Release checksum mismatch: '+file);
   await writeFile(join(directory,file),bytes);
  }
  const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  if(pkg.name!=='free-games-discord-bot' || pkg.version!==manifest.version)throw new Error('Wrong update package');
  for(const file of ['bot.mjs','run.mjs','updater.mjs','test.mjs'])await execute(process.execPath,['--check',join(directory,file)]);
  return {sha,directory,version:pkg.version};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
export async function applyUpdate(update) {
 const backup=join(ROOT,'.update-backups',`${Date.now()}-${update.sha.slice(0,8)}`);await mkdir(backup,{recursive:true});
 const originals=[];
 try {
  for(const file of UPDATE_FILES) {
   if(existsSync(join(ROOT,file))){await copyFile(join(ROOT,file),join(backup,file));originals.push(file);}
  }
  const current=existsSync(join(ROOT,'package-lock.json'))?await readFile(join(ROOT,'package-lock.json'),'utf8'):'';
  const incoming=await readFile(join(update.directory,'package-lock.json'),'utf8');
  for(const file of UPDATE_FILES)await copyFile(join(update.directory,file),join(ROOT,file));
  if(current!==incoming)await execute('npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
  await writeFile(join(ROOT,'.update-version.json'),JSON.stringify({sha:update.sha,version:update.version,backup},null,2));
  console.log(`Updated to ${update.version}; backup saved. Configuration and state preserved.`);
 }catch(error){
  for(const file of UPDATE_FILES){if(originals.includes(file))await copyFile(join(backup,file),join(ROOT,file));else await rm(join(ROOT,file),{force:true});}
  try{await execute('npm',['ci','--ignore-scripts','--no-audit','--no-fund']);}catch{console.error('Dependency restore failed; run npm ci before restarting.');}
  throw new Error(`Update rolled back: ${error.message}`);
 }finally{await rm(update.directory,{recursive:true,force:true});}
}

export async function rollbackUpdate() {
 const marker=JSON.parse(await readFile(join(ROOT,'.update-version.json'),'utf8'));
 const backup=marker.backup;
 const base=join(ROOT,'.update-backups');
 if(typeof backup!=='string' || dirname(backup)!==base)throw new Error('No valid local update backup');
 for(const file of UPDATE_FILES)await access(join(backup,file));
 // Restore through the same transactional installer, creating a recovery backup.
 const stage=join(ROOT,'.update-stage','rollback-'+Date.now());await mkdir(stage,{recursive:true});
 for(const file of UPDATE_FILES)await copyFile(join(backup,file),join(stage,file));
 const pkg=JSON.parse(await readFile(join(stage,'package.json'),'utf8'));
 await applyUpdate({sha:marker.sha,directory:stage,version:pkg.version});
 await writeFile(join(ROOT,'.update-status.json'),JSON.stringify({checkedAt:new Date().toISOString(),result:'Rolled back; current release skipped until a newer commit is published'},null,2));
}
