// Rebuild background/content readers and copy the lightweight, unbundled side panel.
// Run `npm ci && npm run build` from this directory.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', {recursive:true,force:true});
mkdirSync('dist', {recursive:true});
const shared={bundle:true,format:'iife',platform:'browser',target:'chrome120',logLevel:'info'};
await Promise.all([
  build({...shared,entryPoints:['src/background.ts'],outfile:'dist/background.js'}),
  build({...shared,entryPoints:['src/content/index.ts'],outfile:'dist/content.js'}),
]);
cpSync('src/sidepanel/sidepanel.html','dist/sidepanel.html');
cpSync('src/sidepanel/sidepanel.css','dist/sidepanel.css');
cpSync('src/sidepanel/app.js','dist/sidepanel.js');
const manifest=JSON.parse(readFileSync('manifest.json','utf8'));
if(process.env.TEST_ORIGIN){
  const u=new URL(process.env.TEST_ORIGIN);
  const origin=`${u.protocol}//${u.hostname}/*`;
  manifest.host_permissions.push(origin);
  manifest.content_scripts[0].matches.push(origin);
  manifest.host_permissions.push('<all_urls>');
  manifest.name+=' (test build)';
}
writeFileSync('dist/manifest.json',JSON.stringify(manifest,null,2));
console.log('Built Chrome side panel in dist/');
