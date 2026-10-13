import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT,stageUpdate,applyUpdate } from './updater.mjs';
dotenv.config({path:join(ROOT,'.env'),quiet:true});
const lock=join(ROOT,'.runner-lock.json');
if(existsSync(lock)){
 const old=JSON.parse(readFileSync(lock,'utf8'));
 let alive=false;try{process.kill(old.pid,0);alive=true;}catch(error){alive=error.code==='EPERM';}
 if(alive){console.error('Another live-update launcher is running. Close it first.');process.exit(1);}
}
writeFileSync(lock,JSON.stringify({pid:process.pid}));
let child,stopping=false,busy=false,timer;
const unlock=()=>{try{if(JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}catch{}};
process.on('exit',unlock);
function start(){
 child=spawn(process.execPath,['bot.mjs'],{cwd:ROOT,stdio:'inherit'});
 child.on('error',error=>console.error(`Bot start failed: ${error.message}`));
 child.on('exit',code=>{if(!busy && !stopping){console.error(`Bot stopped (${code}); close this launcher and fix the startup error.`);clearInterval(timer);process.exitCode=code || 1;}});
}
async function stopChild(){
 if(!child || child.exitCode!==null)return;
 const current=child;
 await new Promise(resolve=>{const force=setTimeout(()=>current.kill('SIGKILL'),10000);current.once('exit',()=>{clearTimeout(force);resolve();});current.kill('SIGTERM');});
}
async function check(startup=false){
 if(busy || stopping)return;busy=true;
 try{const update=await stageUpdate();if(update){if(!startup)await stopChild();await applyUpdate(update);}}
 catch(error){console.error(`Update: ${error.message}`);}
 finally{busy=false;}
 if(!startup && !stopping && (!child || child.exitCode!==null))start();
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{stopping=true;clearInterval(timer);await stopChild();unlock();process.exit(0);});
if(process.env.UPDATE_ENABLED!=='false')await check(true);
start();
if(process.env.UPDATE_ENABLED!=='false')timer=setInterval(()=>void check(),30*60*1000);
