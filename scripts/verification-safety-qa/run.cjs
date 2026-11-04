const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const repo=path.resolve(__dirname,'../..'),req=createRequire(repo+'/package.json'),esbuild=createRequire(require.resolve('tsx'))('esbuild');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manager-verification-safety-'));
 const postcss=createRequire(req.resolve('@tailwindcss/postcss'))('postcss');
 const css=await postcss([req('@tailwindcss/postcss')()]).process(fs.readFileSync(repo+'/src/app/globals.css','utf8').replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "../components/dashboard";'),{from:repo+'/src/app/globals.css'});
 fs.writeFileSync(dir+'/style.css',css.css);
 await esbuild.build({entryPoints:[__dirname+'/harness.tsx'],bundle:true,outfile:dir+'/bundle.js',loader:{'.tsx':'tsx','.ts':'ts'},jsx:'automatic',alias:{'convex/react':__dirname+'/transport.ts','@':repo+'/src'},nodePaths:[repo+'/node_modules'],define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(dir+'/index.html','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"></head><body style="margin:0;background:#0d151d"><div id="root"></div><script src="bundle.js"></script></body></html>');
 for(const [name,size] of [['mobile','390,844'],['desktop','1440,900']]){
  const args=['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost','--allow-file-access-from-files','--virtual-time-budget=1500',`--window-size=${name === 'mobile' ? '500,844' : size}`,`--screenshot=${dir}/${name}.png`,'file://'+dir+'/index.html'+(name === 'mobile' ? '?width=390' : '')];
  execFileSync('google-chrome',args,{stdio:'ignore',timeout:30000});
 }
 const html=execFileSync('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--allow-file-access-from-files','--virtual-time-budget=1500','--dump-dom','file://'+dir+'/index.html'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000});
 for(const text of ['Last sync: checks passed','can expire','does not authorise handover','Last reported checks','Open website rental'])if(!html.includes(text))throw Error('Missing rendered safety text: '+text);
 console.log('PASS actual Manager verification panel with synthetic data. Screenshots: '+dir);
})().catch(error=>{console.error(error);process.exitCode=1});
